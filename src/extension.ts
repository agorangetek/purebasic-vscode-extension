/*
 * VS Code entry point.
 *
 * All the language logic lives in ./service (editor-agnostic, plain objects);
 * this file only translates between those plain objects and the vscode API.
 */
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import {
	allBlocks,
	builtinCount,
	builtinSource,
	canonicalKeyword,
	extraKeywords,
	generatedKeywordCanonical,
	setExtraKeywords,
} from './service/builtins.ts';
import { blockOpenerAt } from './service/blocks.ts';
import { canonicalizeIdentifiers } from './service/casing.ts';
import { maskSource, parseDocument, wordBefore } from './service/parser.ts';
import { buildCompletions } from './service/completion.ts';
import { getHover } from './service/hover.ts';
import {
	groupSymbols,
	includeGroup,
	includeSearchPaths,
	pathOfUri,
	resolveIncludeTargets,
	uriForPath,
} from './service/includes.ts';
import { PbIndex } from './service/index.ts';
import { addKeywordsToGrammar, keywordEntry, newKeywordNames, parseKeywordsData } from './service/keywords.ts';
import {
	compilerArguments,
	outputPathFor,
	resolveCompiler,
	hasTerminalWindow,
	openTerminalWindow,
	shellCommand,
	splitCommandLine,
	temporaryOutputFor,
	waitForExitMarker,
	writeLaunchScript,
	type CompilerSettings,
} from './service/compiler.ts';
import { getSignatureHelp } from './service/signature.ts';
import type { PbCompletionItem, PbCompletionKind, PbDocument, PbSymbol } from './service/types.ts';

const LANGUAGE = 'purebasic';

let index: PbIndex;
let output: vscode.OutputChannel;

function config() {
	const c = vscode.workspace.getConfiguration('purebasic');
	return {
		enable: c.get<boolean>('completion.enable', true),
		keywords: c.get<boolean>('completion.keywords', true),
		builtins: c.get<boolean>('completion.builtins', true),
		snippets: c.get<boolean>('completion.snippets', true),
		minChars: c.get<number>('completion.minChars', 3),
		workspace: c.get<boolean>('index.workspace', true),
		maxFiles: c.get<number>('index.maxFiles', 400),
		canonicalCase: c.get<boolean>('format.canonicalCase', true),
		keywordsPath: c.get<string>('keywords.path', ''),
		trace: c.get<string>('trace.server', 'off'),
	};
}

function trace(message: string): void {
	if (config().trace === 'off') return;
	output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * The name being typed at the caret, with its sigil, read from the line itself.
 * A sigil on its own counts -- `@` already asks for a reference, and the editor
 * needs to be told that rather than be handed an empty word.
 */
function typedWord(line: string, character: number): string {
	return /(?:[*@?]?[A-Za-z_]\w*\$?|[*@?])$/.exec(line.slice(0, character))?.[0] ?? '';
}

/** Parse a document and add it to the index. */
function indexOf(document: vscode.TextDocument): PbDocument {
	return index.index(document.uri.toString(), document.getText());
}

/**
 * The module-level symbols this document may use from other files.
 *
 * PureBasic only sees another file's procedures when an IncludeFile or
 * XIncludeFile chain reaches it, so the workspace index is filtered down to the
 * files that share the document's translation unit -- in both directions, so a
 * file deeper in the chain still sees the symbols of the file that includes it.
 */
function usableSymbols(document: PbDocument): PbSymbol[] {
	if (!config().workspace) return [];
	const group = includeGroup(document.uri, index, config().maxFiles);
	return groupSymbols(group, index, document.uri);
}

function toCompletionKind(kind: PbCompletionKind): vscode.CompletionItemKind {
	switch (kind) {
		case 'function':
			return vscode.CompletionItemKind.Function;
		case 'sub':
			return vscode.CompletionItemKind.Method;
		case 'variable':
			return vscode.CompletionItemKind.Variable;
		case 'field':
			return vscode.CompletionItemKind.Field;
		case 'constant':
			return vscode.CompletionItemKind.Constant;
		case 'type':
			return vscode.CompletionItemKind.Struct;
		case 'label':
			return vscode.CompletionItemKind.Reference;
		case 'module':
			return vscode.CompletionItemKind.Module;
		case 'macro':
			return vscode.CompletionItemKind.Snippet;
		default:
			return vscode.CompletionItemKind.Keyword;
	}
}

/**
 * `label`, but with the first characters re-cased to exactly what was typed.
 *
 * The editor filters the list itself after the provider has returned it, and
 * that filter is fuzzy: it also matches at a word boundary inside a name, and
 * it is the editor's business whether a case mismatch counts. An item's
 * filterText is what it matches against, so spelling the typed prefix the way
 * the user typed it makes the item match in any case -- `Mess`, `mess` and
 * `MESS` all keep `MessageRequester` -- without changing the label that is
 * displayed or inserted.
 */
function withTypedCase(label: string, typed: string): string {
	if (typed.length === 0 || label.length < typed.length) return label;
	if (!label.toLowerCase().startsWith(typed.toLowerCase())) return label;
	return typed + label.slice(typed.length);
}

function toCompletionItem(item: PbCompletionItem, typed = ''): vscode.CompletionItem {
	// The object form of the label is what renders the trailing file name: VS Code
	// shows `description` dimmed right after the label, with no way to draw a row
	// of its own for a group heading.
	const label = item.labelDescription
		? { label: item.label, description: item.labelDescription }
		: item.label;
	const result = new vscode.CompletionItem(label, toCompletionKind(item.kind));
	result.detail = item.detail;
	result.sortText = item.sortText;
	result.filterText = withTypedCase(item.filterText ?? item.label, typed);

	if (item.isSnippet) {
		result.insertText = new vscode.SnippetString(item.insertText);
	} else {
		result.insertText = item.insertText;
	}

	if (item.documentation) {
		const md = new vscode.MarkdownString(item.documentation);
		md.isTrusted = false;
		result.documentation = md;
	}
	return result;
}

function toSymbolKind(kind: PbSymbol['kind']): vscode.SymbolKind {
	switch (kind) {
		case 'procedure':
		case 'declare':
		case 'prototype':
		case 'macro':
			return vscode.SymbolKind.Function;
		case 'structure':
		case 'interface':
			return vscode.SymbolKind.Struct;
		case 'module':
			return vscode.SymbolKind.Namespace;
		case 'enumeration':
			return vscode.SymbolKind.Enum;
		case 'constant':
		case 'enummember':
			return vscode.SymbolKind.Constant;
		case 'field':
			return vscode.SymbolKind.Field;
		case 'label':
			return vscode.SymbolKind.Key;
		default:
			return vscode.SymbolKind.Variable;
	}
}

/** Index every .pb/.pbi file in the workspace, in the background. */
async function indexWorkspace(): Promise<void> {
	const cfg = config();
	if (!cfg.workspace) return;

	const files = await vscode.workspace.findFiles('**/*.{pb,pbi}', '**/node_modules/**', cfg.maxFiles);
	trace(`indexing ${files.length} workspace files`);
	for (const file of files) {
		try {
			const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
			if (open) {
				indexOf(open);
				continue;
			}
			const bytes = await vscode.workspace.fs.readFile(file);
			index.index(file.toString(), Buffer.from(bytes).toString('utf8'));
		} catch (error) {
			trace(`failed to index ${file.toString()}: ${String(error)}`);
		}
	}
	trace(`index: ${JSON.stringify(index.stats())}`);

	/*
	 * An IncludeFile may name a file the glob never saw: outside the folder, or
	 * reachable only from an open document.  A suggestion is only correct when an
	 * include chain leads to the file, so walk the chain from the open documents
	 * and read whatever is still missing.
	 */
	const seeds = vscode.workspace.textDocuments
		.filter((doc) => doc.languageId === LANGUAGE)
		.map((doc) => doc.uri.toString());
	await indexIncludedFiles(seeds);
}

/** Read and index the files the given documents include, transitively. */
async function indexIncludedFiles(seeds: readonly string[]): Promise<void> {
	const limit = config().maxFiles;
	const searchPaths = includeSearchPaths(index);
	const seen = new Set(seeds);
	const queue = [...seeds];

	while (queue.length > 0 && seen.size <= limit) {
		const uri = queue.shift()!;
		const parsed = index.get(uri);
		if (!parsed) continue;

		for (const target of parsed.includes) {
			for (const candidate of resolveIncludeTargets(pathOfUri(uri), target, searchPaths)) {
				const existing = uriForPath(index, candidate);
				if (existing !== undefined) {
					if (!seen.has(existing)) {
						seen.add(existing);
						queue.push(existing);
					}
					break;
				}

				const file = vscode.Uri.file(candidate);
				try {
					const bytes = await vscode.workspace.fs.readFile(file);
					const added = file.toString();
					index.index(added, Buffer.from(bytes).toString('utf8'));
					seen.add(added);
					queue.push(added);
					trace(`indexed included file ${candidate}`);
				} catch {
					// not there (or not readable): the compiler would not find it either
				}
				break;
			}
		}
	}
}

/*
 * Keywords from the user's own KeywordsData.pbi.
 *
 * The generated keyword list is only as new as this extension's last build, so
 * a reader can point `purebasic.keywords.path` at the IDE's table and have a new
 * PureBasic's reserved words appear without waiting for a release here.
 *
 * Two halves, and they differ in when they take effect:
 *
 *   - COMPLETION, hover and canonical case read the overlay in ./service/builtins,
 *     which is applied in memory and is effective immediately;
 *   - HIGHLIGHTING reads the TextMate grammar file the editor loads, and there is
 *     no API to register one at runtime, so the new words are merged into that
 *     file and only take effect after a window reload.  The merge is strictly
 *     additive: it appends to one keyword alternation and touches nothing else,
 *     so it can never drop a rule the generator wrote.
 *
 * The .pbi file does not ship with a PureBasic installation -- it belongs to the
 * IDE source -- so a path that is not set simply means "do nothing".
 */
async function refreshKeywords(context: vscode.ExtensionContext, announce: boolean): Promise<void> {
	const path = config().keywordsPath.trim();
	if (!path) {
		setExtraKeywords([]);
		return;
	}

	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path))).toString('utf8');
	} catch (error) {
		trace(`keywords: cannot read ${path}: ${String(error)}`);
		if (announce) {
			void vscode.window.showWarningMessage(`PureBasic: cannot read the keyword file ${path}.`);
		}
		return;
	}

	// measured against the generated list AND the current overlay, so running
	// this again -- on a config change, or by hand -- cannot double-add
	const current = extraKeywords();
	const known = [...Object.keys(generatedKeywordCanonical()), ...current.map((i) => i.lower)];
	const added = newKeywordNames(known, parseKeywordsData(text));
	setExtraKeywords([...current, ...added.map(keywordEntry)]);
	if (added.length === 0) {
		trace(`keywords: ${path} has nothing new (${current.length} from earlier refreshes)`);
		if (announce) {
			void vscode.window.showInformationMessage(
				`PureBasic: no new keywords in ${path}.`,
			);
		}
		return;
	}

	output.appendLine(`keywords: ${added.length} new from ${path}: ${added.join(', ')}`);

	// completion is live already; the colours need the grammar file and a reload
	const grammarFile = vscode.Uri.joinPath(context.extensionUri, 'syntaxes', 'purebasic.tmLanguage.json');
	let reloadNeeded = false;
	try {
		const before = Buffer.from(await vscode.workspace.fs.readFile(grammarFile)).toString('utf8');
		const merged = addKeywordsToGrammar(before, added);
		if (merged.added.length > 0) {
			await vscode.workspace.fs.writeFile(grammarFile, Buffer.from(merged.text, 'utf8'));
			reloadNeeded = true;
			trace(`keywords: added ${merged.added.join(', ')} to the grammar`);
		}
	} catch (error) {
		// a read-only install costs the colours and not the completion
		trace(`keywords: cannot update the grammar file: ${String(error)}`);
	}

	const detail = reloadNeeded
		? 'Reload the window to colour them.'
		: 'Highlighting could not be updated; they are offered in completion.';
	void vscode.window
		.showInformationMessage(`PureBasic: ${added.length} new keyword(s): ${added.join(', ')}. ${detail}`, 'Reload Window')
		.then((choice) => {
			if (choice === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
		});
}

/*
 * Running the compiler.
 *
 * The settings mirror the IDE's Compiler Options dialog and the switches are the
 * ones `pbcompiler -h` documents (see ./service/compiler.ts).  Everything runs in
 * a terminal, so the compiler's progress, its errors and the program's own output
 * all land in the same place -- which is also where an interactive program can be
 * answered.
 */
function compilerSettings(): CompilerSettings {
	const c = vscode.workspace.getConfiguration('purebasic.compiler');
	return {
		path: c.get<string>('path', ''),
		debugger: c.get<boolean>('debugger', true),
		optimizer: c.get<boolean>('optimizer', true),
		threadsafe: c.get<boolean>('threadsafe', true),
		purifier: c.get<boolean>('purifier', false),
		onErrorLines: c.get<boolean>('onErrorLines', false),
		executableFormat: c.get<'macos' | 'console' | 'dylib'>('executableFormat', 'macos'),
		subsystem: c.get<string>('subsystem', ''),
		outputPath: c.get<string>('outputPath', ''),
		commandLine: c.get<string>('commandLine', ''),
		quiet: c.get<boolean>('quiet', false),
	};
}

/*
 * Two terminals, each reused until the directory changes.
 *
 * The compiler has to run in the file's own directory so that its relative
 * Includes resolve, so a terminal is replaced when that directory changes rather
 * than left pointing at the wrong place.  There are two because the two kinds of
 * output want different places: the compiler's messages belong in a build log
 * you can read without the program's chatter in it, and the program -- whose
 * `Debug` output is only there when the debugger is on -- gets a terminal of its
 * own.
 */
const terminals = new Map<string, { terminal: vscode.Terminal; cwd: string }>();

function terminalFor(name: string, cwd: string): vscode.Terminal {
	const existing = terminals.get(name);
	if (existing && existing.cwd === cwd && existing.terminal.exitStatus === undefined) {
		return existing.terminal;
	}
	existing?.terminal.dispose();
	const terminal = vscode.window.createTerminal({ name, cwd });
	terminals.set(name, { terminal, cwd });
	return terminal;
}

/*
 * Where the compiler commands write, always: the user's own settings.
 *
 * The IDE keeps these in its global [CompilerDefaults] and lets a project
 * override them in its .pbsp, and this follows that: what you set from the
 * buttons is your default everywhere, not a property of whichever folder
 * happened to be open.  A project's own .vscode/settings.json still wins for
 * the keys it names, which is the point of it -- but nothing here writes there.
 */
function configurationTarget(): vscode.ConfigurationTarget {
	return vscode.ConfigurationTarget.Global;
}

/** Turn the debugger on or off, and say so. */
async function setDebugger(enabled: boolean): Promise<void> {
	const c = vscode.workspace.getConfiguration('purebasic.compiler');
	await c.update('debugger', enabled, configurationTarget());
	void vscode.window.setStatusBarMessage(`PureBasic: debugger ${enabled ? 'on' : 'off'}`, 3000);
}

/** The active PureBasic file, saved, or undefined with a word about why. */
async function compilableDocument(): Promise<vscode.TextDocument | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== LANGUAGE) {
		void vscode.window.showInformationMessage('PureBasic: open a .pb file first.');
		return undefined;
	}
	// the compiler reads the file from disk, so an unsaved buffer would compile
	// the previous version of the code
	if (editor.document.isDirty && !(await editor.document.save())) {
		void vscode.window.showWarningMessage('PureBasic: the file could not be saved, so nothing was compiled.');
		return undefined;
	}
	return editor.document;
}

/**
 * Build the file, and run it in a terminal of its own.
 *
 * A build always happens first, even for Run: that is what keeps the compiler's
 * messages in the build terminal, where they can be read, and gives the program
 * a terminal where its own output -- and the debugger's, when the debugger is on
 * -- is the only thing in it.  The two are sequenced through a file, because a
 * command sent to a terminal reports nothing back and the program must not start
 * before the build that produces it has finished.
 */
async function runOrCompile(compileOnly: boolean): Promise<void> {
	const document = await compilableDocument();
	if (!document) return;

	const settings = compilerSettings();
	const compiler = resolveCompiler(settings.path);
	const source = document.uri.fsPath;
	const cwd = dirname(source);
	// Run builds a temporary executable; Compile writes where it was told
	const target = compileOnly ? outputPathFor(source, settings) : temporaryOutputFor(source);

	// the compiler writes its output with the system linker, which will not
	// create the directory for it -- and a configured output path may name one
	// that does not exist either
	try {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(target)));
	} catch (error) {
		trace(`compiler: cannot create ${dirname(target)}: ${String(error)}`);
	}

	const build = terminalFor('PureBasic', cwd);
	build.show(true);

	const marker = join(tmpdir(), `pb-exit-${Date.now()}`);
	const line = shellCommand([compiler, ...compilerArguments(settings, target), source]);
	build.sendText(`${line}; printf '%s' "$?" > ${shellCommand([marker])}`, true);
	trace(`compiler: ${line}`);

	if (compileOnly) {
		void vscode.window.setStatusBarMessage(`PureBasic: building ${basename(target)}`, 5000);
		return;
	}

	const code = await waitForExitMarker(marker);
	void vscode.workspace.fs.delete(vscode.Uri.file(marker)).then(undefined, () => undefined);

	if (code === undefined) {
		void vscode.window.showWarningMessage(
			'PureBasic: the build did not finish, so the program was not started.',
		);
		return;
	}
	if (code !== 0) {
		// the build terminal is on screen and holds the compiler's own message
		void vscode.window.showErrorMessage('PureBasic: the build failed. See the PureBasic terminal.');
		return;
	}

	const args = splitCommandLine(settings.commandLine);

	// The program gets a window of its own where that is possible, so that its
	// output -- the debugger's above all -- is somewhere it can be read without
	// the compiler's log beside it.  Where it is not, the editor's terminal
	// stands in rather than nothing running.
	if (hasTerminalWindow()) {
		try {
			await openTerminalWindow(writeLaunchScript(target, args, cwd));
			trace(`program: ${target} in a Terminal window`);
			return;
		} catch (error) {
			trace(`program: no Terminal window (${String(error)}); using the editor's`);
		}
	}

	const program = terminalFor('PureBasic Program', cwd);
	program.show(true);
	program.sendText(shellCommand([target, ...args]), true);
	trace(`program: ${target}`);
}

/**
 * `PureBasic: Compiler Settings` -- the IDE's dialog as a list.
 *
 * Each entry shows what it is set to and changes one thing, so the common
 * choices are two clicks rather than a trip through the settings editor.  The
 * last entry opens that editor for everything else.
 */
async function chooseCompilerSettings(): Promise<void> {
	const c = vscode.workspace.getConfiguration('purebasic.compiler');
	const onOff = (value: boolean) => (value ? 'on' : 'off');

	type Choice = vscode.QuickPickItem & { key?: string; boolean?: boolean; input?: 'text' | 'file' };
	const choices: Choice[] = [
		{ label: 'Debugger', description: onOff(c.get('debugger', true)), detail: '-d  Debug output and runtime error lines', key: 'debugger', boolean: true },
		{ label: 'Optimizer', description: onOff(c.get('optimizer', true)), detail: '-z  Optimize generated code', key: 'optimizer', boolean: true },
		{ label: 'Threadsafe', description: onOff(c.get('threadsafe', true)), detail: '-t  Create a threadsafe executable', key: 'threadsafe', boolean: true },
		{ label: 'Purifier', description: onOff(c.get('purifier', false)), detail: '-pf  Enable the purifier', key: 'purifier', boolean: true },
		{ label: 'OnError lines', description: onOff(c.get('onErrorLines', false)), detail: '-l  Enable OnError lines support', key: 'onErrorLines', boolean: true },
		{ label: 'Quiet', description: onOff(c.get('quiet', false)), detail: '-q  Show only errors', key: 'quiet', boolean: true },
		{ label: 'Executable format', description: c.get('executableFormat', 'macos'), detail: 'An application, a console one, or a shared library', key: 'executableFormat' },
		{ label: 'Output path', description: c.get('outputPath', '') || 'beside the source', detail: 'Where Compile writes', key: 'outputPath', input: 'text' },
		{ label: 'Command line', description: c.get('commandLine', '') || 'none', detail: 'Arguments to start the program with', key: 'commandLine', input: 'text' },
		{ label: 'Subsystem', description: c.get('subsystem', '') || 'default', detail: '-s  Library subsystem', key: 'subsystem', input: 'text' },
		{ label: 'Compiler', description: resolveCompiler(c.get<string>('path', '')), detail: 'The pbcompiler to run', key: 'path', input: 'file' },
		{ label: 'Open the settings editor', detail: 'Every PureBasic setting, including the ones above' },
	];

	const pick = await vscode.window.showQuickPick(choices, {
		title: 'PureBasic Compiler Settings',
		placeHolder: 'Choose a setting to change',
	});
	if (!pick) return;

	if (!pick.key) {
		await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:agorangetek.purebasic');
		return;
	}

	let value: unknown;
	if (pick.boolean) {
		value = !c.get(pick.key, false);
	} else if (pick.key === 'executableFormat') {
		const formats = ['macos', 'console', 'dylib'];
		value = await vscode.window.showQuickPick(formats, {
			title: 'Executable format',
			placeHolder: c.get('executableFormat', 'macos'),
		});
	} else if (pick.input === 'file') {
		const chosen = await vscode.window.showOpenDialog({
			title: 'Choose pbcompiler',
			canSelectMany: false,
			openLabel: 'Use this compiler',
		});
		value = chosen?.[0]?.fsPath;
	} else {
		value = await vscode.window.showInputBox({
			title: pick.label,
			value: c.get<string>(pick.key, ''),
			prompt: pick.detail,
		});
	}
	if (value === undefined) return;

	await c.update(pick.key, value, configurationTarget());
	void vscode.window.setStatusBarMessage(`PureBasic: ${pick.label} set to ${String(value) || 'default'}`, 4000);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel('PureBasic');
	index = new PbIndex(config().maxFiles);
	context.subscriptions.push(output);

	// Awaited, so activation is not "done" with the grammar half-written.  A
	// keyword file that cannot be read must never fail activation, hence the
	// catch: it costs the refresh, not the extension.
	try {
		await refreshKeywords(context, false);
	} catch (error) {
		trace(`keywords: ${String(error)}`);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('purebasic.run', () => runOrCompile(false)),
		vscode.commands.registerCommand('purebasic.compile', () => runOrCompile(true)),
		// Two commands, not one toggle: the title-bar button's icon belongs to
		// the command, so turning it on and turning it off have to be separate
		// to be drawn differently.  Which one is offered follows the setting
		// itself, which the menu's `when` reads directly.
		vscode.commands.registerCommand('purebasic.debuggerOn', () => setDebugger(true)),
		vscode.commands.registerCommand('purebasic.debuggerOff', () => setDebugger(false)),
		vscode.commands.registerCommand('purebasic.compilerSettings', () => chooseCompilerSettings()),
		vscode.commands.registerCommand('purebasic.refreshKeywords', () => refreshKeywords(context, true)),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('purebasic.keywords.path')) void refreshKeywords(context, true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('purebasic.reindex', async () => {
			index.clear();
			for (const doc of vscode.workspace.textDocuments) {
				if (doc.languageId === LANGUAGE) indexOf(doc);
			}
			await indexWorkspace();
			void vscode.window.showInformationMessage(
				`PureBasic: indexed ${index.stats().files} files, ${index.stats().symbols} symbols.`,
			);
		}),
		vscode.commands.registerCommand('purebasic.showIndexStats', () => {
			const stats = index.stats();
			output.show(true);
			output.appendLine(
				`built-ins: ${builtinCount()} (${builtinSource()}); indexed: ${stats.files} files, ${stats.symbols} symbols`,
			);
		}),
		vscode.commands.registerCommand('purebasic.diagnoseCompletion', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== LANGUAGE) {
				void vscode.window.showInformationMessage('PureBasic: open a .pb file first.');
				return;
			}
			const document = editor.document;
			const position = editor.selection.active;
			const line = document.lineAt(position.line).text;
			const word = typedWord(line, position.character);
			const cfg = config();
			const items = buildCompletions({
				document: indexOf(document),
				workspaceSymbols: usableSymbols(indexOf(document)),
				position: { line: position.line, character: position.character },
				word,
				options: {
					keywords: cfg.keywords,
					builtins: cfg.builtins,
					snippets: cfg.snippets,
					minChars: cfg.minChars,
				},
			});

			const summary =
				`at ${position.line}:${position.character} typed ${JSON.stringify(word)} -> ${items.length} items ` +
				`(minChars ${cfg.minChars}, keywords ${cfg.keywords}, builtins ${cfg.builtins}, enable ${cfg.enable})`;
			output.show(true);
			output.appendLine(`diagnose: ${summary}`);
			output.appendLine(`  first: ${items.slice(0, 8).map((i) => i.label).join(', ')}`);
			void vscode.window.showInformationMessage(`PureBasic: ${summary}`);
		}),
	);

	// keep the index in sync with edits
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (doc.languageId === LANGUAGE) indexOf(doc);
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.languageId === LANGUAGE) indexOf(event.document);
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			if (doc.languageId === LANGUAGE) index.remove(doc.uri.toString());
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('purebasic')) {
				index = new PbIndex(config().maxFiles);
				void indexWorkspace();
			}
		}),
	);

	/* ------------------------------------------------ format / canonical case */

	/**
	 * Every symbol visible in `document`: its own, plus those of the files it
	 * includes, which are the same program.  Without following the includes, a
	 * procedure declared in a .pbi could not be recognised as the author's.
	 */
	async function translationUnitSymbols(document: vscode.TextDocument): Promise<PbSymbol[]> {
		const symbols: PbSymbol[] = [];
		const seen = new Set<string>();
		const queue: { uri: vscode.Uri; text: string; depth: number }[] = [
			{ uri: document.uri, text: document.getText(), depth: 0 },
		];

		while (queue.length > 0 && seen.size < 32) {
			const current = queue.shift()!;
			const key = current.uri.toString();
			if (seen.has(key) || current.depth > 6) continue;
			seen.add(key);

			let parsed: PbDocument;
			try {
				parsed = parseDocument(key, current.text);
			} catch {
				continue;
			}
			symbols.push(...parsed.symbols);

			for (const include of parsed.includes) {
				const target = vscode.Uri.joinPath(current.uri, '..', include);
				try {
					const bytes = await vscode.workspace.fs.readFile(target);
					queue.push({
						uri: target,
						text: Buffer.from(bytes).toString('utf8'),
						depth: current.depth + 1,
					});
				} catch {
					// somewhere we cannot read: nothing to add
				}
			}
		}
		return symbols;
	}

	/** Restore canonical spellings inside `range`, as a single replacement. */
	async function casingEdits(
		document: vscode.TextDocument,
		range: vscode.Range,
	): Promise<{ edit: vscode.TextEdit; changes: number } | undefined> {
		if (!config().canonicalCase) return undefined;
		const source = document.getText(range);
		const result = canonicalizeIdentifiers(source, await translationUnitSymbols(document));
		if (result.changes === 0) return undefined;
		return { edit: vscode.TextEdit.replace(range, result.text), changes: result.changes };
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('purebasic.formatText', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== LANGUAGE) return;

			const selection = editor.selections.find((s) => !s.isEmpty);
			const range =
				selection ??
				new vscode.Range(
					editor.document.positionAt(0),
					editor.document.positionAt(editor.document.getText().length),
				);

			const result = await casingEdits(editor.document, range);
			if (!result) {
				void vscode.window.showInformationMessage('PureBasic: nothing to re-case.');
				return;
			}
			await editor.edit((builder) => builder.replace(result.edit.range, result.edit.newText));
			void vscode.window.setStatusBarMessage(
				`PureBasic: re-cased ${result.changes} identifiers.`,
				4000,
			);
		}),
	);

	// also reachable through Format Document / Format Selection
	const formattingProvider: vscode.DocumentFormattingEditProvider &
		vscode.DocumentRangeFormattingEditProvider = {
		async provideDocumentFormattingEdits(document) {
			const result = await casingEdits(
				document,
				new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				),
			);
			return result ? [result.edit] : [];
		},
		async provideDocumentRangeFormattingEdits(document, range) {
			const result = await casingEdits(document, range);
			return result ? [result.edit] : [];
		},
	};
	context.subscriptions.push(
		vscode.languages.registerDocumentFormattingEditProvider(LANGUAGE, formattingProvider),
		vscode.languages.registerDocumentRangeFormattingEditProvider(LANGUAGE, formattingProvider),
	);

	/*
	 * Enter is bound to a command of ours for PureBasic, because the caret is
	 * the point: finishing a block opener has to leave the caret on the body
	 * line, and an edit that lands on the caret takes the caret with it -- a
	 * formatting provider has no way to put it back.  A command can.
	 *
	 * Everything else, and every case this has no business in, falls through to
	 * the editor's own Enter, so auto-indent, multi-cursor and the suggest
	 * widget are untouched.
	 */
	context.subscriptions.push(
		vscode.commands.registerCommand('purebasic.newline', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === LANGUAGE && (await finishBlockLine(editor))) {
				return;
			}
			await vscode.commands.executeCommand('default:type', { text: '\n' });
		}),
	);

	/**
	 * The two halves of a smart newline: the line the caret is on is re-cased,
	 * and a line that opens a block gets its terminator, with the caret left on
	 * the body line.  Returns true when the newline has been dealt with here,
	 * and false when the editor's own Enter should finish the job.
	 */
	async function finishBlockLine(editor: vscode.TextEditor): Promise<boolean> {
		if (!editor.selection.isEmpty) return false;
		const caret = editor.selection.active;
		const document = editor.document;
		const line = document.lineAt(caret.line);

		// only the end of the line: in the middle, Enter just splits it
		if (caret.character !== line.text.length) return false;

		const lineText = config().canonicalCase
			? canonicalizeIdentifiers(line.text, indexOf(document).symbols).text
			: line.text;

		const block = blockOpenerAt(lineText, allBlocks());
		// a declaration that is not finished yet -- `Procedure test`, with no
		// parentheses -- is not the head of a block until its signature closes
		const unfinished =
			block !== undefined &&
			/^(?:procedure|declare|prototype)/i.test(block.opener) &&
			!lineText.includes('(');

		if (!block || unfinished) {
			// no block to close, but the line is still re-cased
			if (lineText !== line.text) await editor.edit((b) => b.replace(line.range, lineText));
			return false;
		}

		const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
		const unit = editor.options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
		const base = /^\s*/.exec(lineText)?.[0] ?? '';
		const body = base + unit;

		await editor.edit((b) =>
			b.replace(line.range, `${lineText}\n${body}\n${base}${block.closers[0]}`),
		);

		// TextLine.lineNumber is the line's own index (zero-based, despite the
		// name), so the body line is the caret's line plus one
		const after = new vscode.Position(caret.line + 1, body.length);
		editor.selections = [new vscode.Selection(after, after)];
		return true;
	}

	/*
	 * A space re-cases the word it finishes -- `procedure ` becomes `Procedure `
	 * as it is typed -- and ')' re-cases the whole line it closes, so a
	 * signature is fixed the moment the parenthesis ends it.
	 *
	 * Both edits end before the caret, which is why they can be formatting edits
	 * where Enter needed a command: nothing here can move the caret.
	 *
	 * A space only touches reserved words.  A library command can also be a
	 * variable name (`left`, `open`, `print`), so re-casing one as you type
	 * could rewrite a name the author chose, and with implicit variables the
	 * name may not even have been declared yet.  Commands are still re-cased
	 * when the call closes on ')', on Enter, and by Format Text, where the
	 * declared names are known.
	 */
	context.subscriptions.push(
		vscode.languages.registerOnTypeFormattingEditProvider(
			LANGUAGE,
			{
				provideOnTypeFormattingEdits(document, position, ch) {
					if (!config().canonicalCase) return undefined;
					const line = document.lineAt(position.line);

					if (ch === ' ') {
						const finished = wordBefore(line.text, position.character - 1);
						if (!finished) return undefined;
						const canonical = canonicalKeyword(finished.word);
						if (!canonical || canonical === finished.word) return undefined;
						// a keyword written in a comment or a string stays as written
						const masked = maskSource(line.text)[0] ?? '';
						if (masked.slice(finished.start, finished.end) !== finished.word) return undefined;
						return [
							vscode.TextEdit.replace(
								new vscode.Range(position.line, finished.start, position.line, finished.end),
								canonical,
							),
						];
					}

					const recased = canonicalizeIdentifiers(line.text, indexOf(document).symbols);
					if (recased.changes === 0) return undefined;
					return [vscode.TextEdit.replace(line.range, recased.text)];
				},
			},
			')',
			' ',
		),
	);

	/* ---------------------------------------------------------- completion */
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			LANGUAGE,
			{
				provideCompletionItems(document, position, _token, context) {
					const cfg = config();
					if (!cfg.enable) return undefined;

					const parsed = indexOf(document);
					// What has actually been typed, read straight from the line.  The
					// editor's own word range answers a different question -- it spans
					// the whole word, which may extend past the cursor when editing
					// inside one -- and how it treats a pattern like this one is the
					// editor's business, so the text is taken directly instead.
					const line = document.lineAt(position.line).text;
					const word = typedWord(line, position.character);

					// a type or member list is asked for by the '.' or '\' itself, so the
					// minimum length does not apply to it
					const asked =
						context?.triggerCharacter === '.' || context?.triggerCharacter === '\\';

					const items = buildCompletions({
						document: parsed,
						workspaceSymbols: usableSymbols(parsed),
						position: { line: position.line, character: position.character },
						word,
						options: {
							keywords: cfg.keywords,
							builtins: cfg.builtins,
							snippets: cfg.snippets,
							minChars: asked ? 0 : cfg.minChars,
						},
					});

					trace(
						`completion at ${position.line}:${position.character} (typed ${JSON.stringify(word)}) -> ${items.length} items`,
					);
					return items.map((item) => toCompletionItem(item, word));
				},
			},
			'.',
			'\\',
			// `@` starts a procedure address or a variable reference; `*` is
			// also the multiplication sign and `?` needs a label, so neither is
			// a trigger.
			'@',
		),
	);

	/* --------------------------------------------------------------- hover */
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(LANGUAGE, {
			provideHover(document, position) {
				const parsed = indexOf(document);
				const hover = getHover(
					parsed,
					{ line: position.line, character: position.character },
					usableSymbols(parsed),
				);
				if (!hover) return undefined;

				const md = new vscode.MarkdownString(hover.contents);
				md.isTrusted = false;
				const range = new vscode.Range(
					hover.range.startLine,
					hover.range.startChar,
					hover.range.endLine,
					hover.range.endChar,
				);
				return new vscode.Hover(md, range);
			},
		}),
	);

	/* ------------------------------------------------------ signature help */
	context.subscriptions.push(
		vscode.languages.registerSignatureHelpProvider(
			LANGUAGE,
			{
				provideSignatureHelp(document, position) {
					const parsed = indexOf(document);
					const info = getSignatureHelp(
						parsed,
						{ line: position.line, character: position.character },
						usableSymbols(parsed),
					);
					if (!info) return undefined;

					const signature = new vscode.SignatureInformation(
						info.label,
						info.documentation ? new vscode.MarkdownString(info.documentation) : undefined,
					);
					signature.parameters = info.parameters.map(
						(p) =>
							new vscode.ParameterInformation(
								p.label,
								p.documentation ? new vscode.MarkdownString(p.documentation) : undefined,
							),
					);

					const help = new vscode.SignatureHelp();
					help.signatures = [signature];
					help.activeSignature = 0;
					help.activeParameter = info.activeParameter;
					return help;
				},
			},
			'(',
			',',
		),
	);

	/* ----------------------------------------------------- document outline */
	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(LANGUAGE, {
			provideDocumentSymbols(document) {
				const parsed = indexOf(document);
				return parsed.symbols
					.filter((s) => s.scope === '')
					.map((s) => {
						const line = document.lineAt(Math.min(s.line, document.lineCount - 1));
						return new vscode.DocumentSymbol(
							s.name,
							s.detail,
							toSymbolKind(s.kind),
							line.range,
							line.range,
						);
					});
			},
		}),
	);

	// index the open documents immediately, the rest in the background
	for (const doc of vscode.workspace.textDocuments) {
		if (doc.languageId === LANGUAGE) indexOf(doc);
	}
	void indexWorkspace();

	trace(`activated with ${builtinCount()} built-ins from ${builtinSource()}`);
}

export function deactivate(): void {
	index?.clear();
}
