/*
 * VS Code entry point.
 *
 * All the language logic lives in ./service (editor-agnostic, plain objects);
 * this file only translates between those plain objects and the vscode API.
 */
import { spawn } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
	compileSavePanel,
	compilerArguments,
	debugOutputFor,
	parseCompilerOutput,
	placeBuiltFile,
	resolveCompiler,
	runCompiler,
	stagedOutputFor,
	hostPlatform,
	launcherCommand,
	shellCommand,
	splitCommandLine,
	temporaryOutputFor,
	windowsLauncher,
	writeLaunchScript,
	type CompilerSettings,
	type Platform,
} from './service/compiler.ts';
import { PureBasicDebugSession } from './service/debug/session.ts';
import { getSignatureHelp } from './service/signature.ts';
import type { PbCompletionItem, PbCompletionKind, PbDocument, PbSymbol } from './service/types.ts';

const LANGUAGE = 'purebasic';

let index: PbIndex;
let output: vscode.OutputChannel;
/** The build that has just happened, so a debug session does not repeat it. */
let lastBuild: { source: string; target: string; at: number; ok: boolean; command: string; output: string } | undefined;
/** The lines the last build could not compile, for the editor to underline. */
let compilerDiagnostics: vscode.DiagnosticCollection | undefined;
/** Where the program's own output is shown. */
let outputPanel: DebugOutputPanel;

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
		// the older names for both of these are still read, so a setting written
		// before they were renamed keeps working
		executableFormat: formatOf(c.get<string>('executableFormat', 'windowed')),
		subsystem: c.get<string>('subsystem', ''),
		outputPath: c.get<string>('outputPath', ''),
		commandLine: c.get<string>('commandLine', ''),
		quiet: c.get<boolean>('quiet', false),
	};
}

/*
 * One terminal, reused until the directory changes.
 *
 * The compiler has to run in the file's own directory so that its relative
 * Includes resolve, so the terminal is replaced when that directory changes
 * rather than left pointing at the wrong place.  It carries the build log: the
 * program itself is started from it into a window of its own, so the compiler's
 * messages do not scroll away behind the program's output.
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

/** The executable format, the older spellings included. */
function formatOf(value: string): CompilerSettings['executableFormat'] {
	if (value === 'console') return 'console';
	if (value === 'library' || value === 'dylib') return 'library';
	return 'windowed';
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
 * Ask where a Compile should write, in the platform's own save panel.
 *
 * The panel is the system's -- the save panel on macOS, the common dialog on
 * Windows, the desktop's own on Linux -- so it is the one place that knows the
 * volumes, the sidebar and the recent folders of the machine it is on.  What it
 * is offered, and where it opens, is the platform's too: see compileSavePanel.
 */
async function askWhereToWrite(
	source: string,
	settings: CompilerSettings,
	platform: Platform,
): Promise<string | undefined> {
	const panel = compileSavePanel(source, settings, platform);
	const chosen = await vscode.window.showSaveDialog({
		title: panel.title,
		saveLabel: panel.saveLabel,
		defaultUri: vscode.Uri.file(panel.path),
		...(panel.filters ? { filters: panel.filters } : {}),
	});
	return chosen?.fsPath;
}

/** Make sure a directory is there for the compiler to write into. */
async function createFolder(path: string): Promise<void> {
	// the compiler writes its output with the system linker, which will not
	// create the directory for it -- and a configured output path may name one
	// that does not exist either
	try {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path));
	} catch (error) {
		trace(`compiler: cannot create ${path}: ${String(error)}`);
	}
}

/**
 * Put a finished build's log in the terminal, where the compiler's messages
 * belong.
 *
 * Compile hears the compiler from here rather than letting the terminal run it,
 * so the output is replayed from a file: a log handed over as a command of its
 * own cannot be mistaken by the shell for something to run.
 */
function showBuildLog(
	staged: string,
	command: string,
	output: string,
	note: string,
	cwd: string,
	platform: Platform,
): void {
	const file = `${staged}.log`;
	const ending = output === '' || output.endsWith('\n') ? '' : '\n';
	try {
		writeFileSync(file, `$ ${command}\n${output}${ending}[PureBasic] ${note}\n`);
	} catch (error) {
		trace(`compiler: cannot write ${file}: ${String(error)}`);
		return;
	}
	const terminal = terminalFor('PureBasic', cwd);
	terminal.show(true);
	terminal.sendText(shellCommand([platform === 'win32' ? 'type' : 'cat', file], platform), true);
}

/**
 * `PureBasic: Compile to Executable` -- the build first, then where it goes.
 *
 * The build runs from here rather than in the terminal because the save panel
 * has to wait for its result: there is no point asking where to write a program
 * that will not compile, and a build that fails is reported in the terminal
 * instead of being asked about.  What did compile is staged in the temporary
 * directory, under a name of its own so that a Run of the same file keeps its
 * own build, and then moved to the chosen path -- a compiled file is a compiled
 * file, and running the compiler a second time for the same one would be work
 * with nothing to show for it.
 */
/** What a build had to say, and the command that produced it. */
interface Build {
	/** The command line, as the terminal would have shown it. */
	command: string;
	/** What the compiler said. */
	output: string;
	/** Whether it produced what it was asked for. */
	ok: boolean;
}

/**
 * Build the file here rather than in the terminal, and keep what was said.
 *
 * Both buttons build this way: Compile asks where to write only once the build
 * has worked, and Run underlines the line the compiler stopped at before it
 * starts anything -- and neither can be told by a command typed into the
 * terminal.  What the compiler said goes to the terminal all the same.
 */
async function buildFile(
	document: vscode.TextDocument,
	settings: CompilerSettings,
	platform: Platform,
	target: string,
): Promise<Build> {
	const source = document.uri.fsPath;
	await createFolder(dirname(target));

	const compiler = resolveCompiler(settings.path, platform);
	const args = [...compilerArguments(settings, target, platform), source];
	const command = shellCommand([compiler, ...args], platform);
	trace(`compiler: ${command}`);

	// the build is not in the terminal to watch, so the status bar says it is
	// under way until it has something to report
	const building = vscode.window.setStatusBarMessage(`PureBasic: building ${basename(source)}`);
	const result = await runCompiler(compiler, args, dirname(source));
	building.dispose();

	reportCompilerErrors(document, result.output);
	const outcome = { command, output: result.output, ok: result.code === 0 };
	lastBuild = { source, target, at: Date.now(), ...outcome };
	return outcome;
}

/**
 * `PureBasic: Compile to Executable` -- the build first, then where it goes.
 *
 * The build runs from here rather than in the terminal because the save panel
 * has to wait for its result: there is no point asking where to write a program
 * that will not compile, and a build that fails is reported in the terminal
 * instead of being asked about.  What did compile is staged in the temporary
 * directory, under a name of its own so that a Run of the same file keeps its
 * own build, and then moved to the chosen path -- a compiled file is a compiled
 * file, and running the compiler a second time for the same one would be work
 * with nothing to show for it.
 */
async function writeExecutable(
	document: vscode.TextDocument,
	settings: CompilerSettings,
	platform: Platform,
): Promise<void> {
	const source = document.uri.fsPath;
	const cwd = dirname(source);
	const staged = stagedOutputFor(source, platform);
	const build = await buildFile(document, settings, platform, staged);

	if (!build.ok) {
		showBuildLog(staged, build.command, build.output, 'nothing was written: the build failed', cwd, platform);
		void vscode.window.setStatusBarMessage('PureBasic: the build failed, so nothing was written', 5000);
		return;
	}

	const chosen = await askWhereToWrite(source, settings, platform);
	if (!chosen) {
		showBuildLog(staged, build.command, build.output, 'nothing was written: the save panel was cancelled', cwd, platform);
		return;
	}

	try {
		placeBuiltFile(staged, chosen);
	} catch (error) {
		trace(`compiler: cannot put the build at ${chosen}: ${String(error)}`);
		void vscode.window.showErrorMessage(`PureBasic: the build could not be written to ${chosen}: ${String(error)}`);
		return;
	}

	showBuildLog(staged, build.command, build.output, `wrote ${chosen}`, cwd, platform);
	void vscode.window.setStatusBarMessage(`PureBasic: wrote ${basename(chosen)}`, 5000);
}

/** `PureBasic: Compile to Executable`, for the file in the editor. */
async function compileToExecutable(): Promise<void> {
	const document = await compilableDocument();
	if (!document) return;
	await writeExecutable(document, compilerSettings(), hostPlatform());
}

/**
 * `PureBasic: Run` -- under the debugger when there is something to stop at,
 * and in a window of its own when there is not.
 *
 * The debugger button is what decides: on -- green -- the program is built with
 * the debugger in it and run under it, so breakpoints stop it and the stepping
 * commands work; off, it is a plain run in a window of its own, which is
 * faster.  With no breakpoints set there is simply nothing to stop at.
 */
async function runOrDebug(): Promise<void> {
	// every run starts with an empty debug console and an empty build terminal:
	// the last one's output has been read by now, and mixing the two makes
	// neither of them easier
	clearDebugConsole();
	clearCompilerTerminal();

	const document = await compilableDocument();
	if (!document) return;

	if (debuggingRequested()) {
		// built here, before any session exists: a build that fails is the
		// editor's business -- the line underlined, the compiler's log in the
		// terminal -- and a session that failed to launch would say so in a box
		const settings = compilerSettings();
		const platform = hostPlatform();
		const target = debugOutputFor(document.uri.fsPath, platform);
		const build = await buildFile(document, settings, platform, target);
		if (!build.ok) {
			showBuildLog(target, build.command, build.output, 'nothing was started: the build failed', dirname(document.uri.fsPath), platform);
			void vscode.window.setStatusBarMessage('PureBasic: the build failed, so nothing was started', 5000);
			return;
		}
		await startDebugSession(document.uri.fsPath);
		return;
	}
	await runInPanel(document);
}

/** Empty VS Code's debug console, whatever it happens to be showing. */
function clearDebugConsole(): void {
	void vscode.commands
		.executeCommand('workbench.debug.panel.action.clearReplAction')
		.then(undefined, () => undefined);
}

/**
 * Empty the terminal the compiler writes in.
 *
 * It is this extension's own terminal, so it is shown first -- without taking
 * the focus -- and then cleared; when there is none yet there is nothing to
 * clear, which is not a failure.
 */
function clearCompilerTerminal(): void {
	const terminal = terminals.get('PureBasic')?.terminal;
	if (!terminal) return;
	terminal.show(true);
	void vscode.commands
		.executeCommand('workbench.action.terminal.clear')
		.then(undefined, () => undefined);
}

/** Whether a run should be a run under the debugger: the debugger button decides. */
function debuggingRequested(): boolean {
	return compilerSettings().debugger;
}

/**
 * Build the file, and start it in a window of its own.
 *
 * The build comes first, so a file that does not compile starts nothing and has
 * its error underlined; the command that starts the program goes to the
 * terminal once the build has worked.  Where the platform has a window to
 * offer, the program opens in it -- a Terminal window on macOS, a terminal
 * emulator on Linux, a console window on Windows -- and where it has none, it
 * runs in the build terminal rather than not at all.
 */
async function runInPanel(document: vscode.TextDocument): Promise<void> {
	const settings = compilerSettings();
	const platform = hostPlatform();
	const source = document.uri.fsPath;
	const cwd = dirname(source);
	const target = temporaryOutputFor(source, platform);
	const build = await buildFile(document, settings, platform, target);

	if (!build.ok) {
		showBuildLog(target, build.command, build.output, 'nothing was started: the build failed', cwd, platform);
		void vscode.window.setStatusBarMessage('PureBasic: the build failed, so nothing was started', 5000);
		return;
	}

	// the program is started here rather than in a terminal so that what it
	// prints -- `Debug` output above all -- has somewhere to be shown
	const program = spawn(target, splitCommandLine(settings.commandLine), { cwd });
	trace(`compiler: running ${target}`);
	outputPanel.begin(basename(source), () => program.kill());
	program.stdout?.on('data', (chunk: Buffer) => outputPanel.append(chunk.toString()));
	program.stderr?.on('data', (chunk: Buffer) => outputPanel.append(chunk.toString()));
	program.on('error', (error) => outputPanel.finish(`[PureBasic] the program could not be started: ${String(error)}`));
	program.on('exit', (code, signal) =>
		outputPanel.finish(`[PureBasic] the program ${signal ? `was stopped (${signal})` : `exited with ${code}`}`),
	);
}

/**
 * The same run, in a terminal of its own.
 *
 * A program that reads from the keyboard needs a terminal, and so does one whose
 * output is wanted beside the compiler's; the play button no longer does this,
 * but the command is here for when it is what is wanted.
 */
async function runInTerminal(document: vscode.TextDocument): Promise<void> {
	const settings = compilerSettings();
	const platform = hostPlatform();
	const source = document.uri.fsPath;
	const cwd = dirname(source);
	const target = temporaryOutputFor(source, platform);
	const build = await buildFile(document, settings, platform, target);

	if (!build.ok) {
		showBuildLog(target, build.command, build.output, 'nothing was started: the build failed', cwd, platform);
		void vscode.window.setStatusBarMessage('PureBasic: the build failed, so nothing was started', 5000);
		return;
	}

	const args = splitCommandLine(settings.commandLine);
	const launch =
		platform === 'win32'
			? windowsLauncher(target, args, cwd)
			: launcherCommand(writeLaunchScript(target, args, cwd, platform), platform);

	showBuildLog(target, build.command, build.output, 'starting the program', cwd, platform);
	const terminal = terminalFor('PureBasic', cwd);
	terminal.sendText(launch ?? shellCommand([target, ...args], platform), true);
}

/** `PureBasic: Run in a Terminal` -- for a program that wants a keyboard. */
async function runInTerminalCommand(): Promise<void> {
	const document = await compilableDocument();
	if (!document) return;
	await runInTerminal(document);
}

/**
 * Underline the line the compiler stopped at, and take the last one away.
 *
 * The compiler names a line and not a column, so the whole line carries it.  A
 * line of an included file is named as being in that file, and belongs there
 * rather than on the line of the same number in the file that was compiled --
 * which is why the two paths are compared after resolving them, since the
 * compiler reports the path with its symlinks resolved and the editor has the
 * one that was opened.
 */
function reportCompilerErrors(document: vscode.TextDocument, output: string): void {
	const collection = compilerDiagnostics;
	if (!collection) return;

	// a build answers for the whole program, so an error this one does not name
	// is no longer an error: without this, an include that has been fixed keeps
	// its squiggle until that file itself is edited
	collection.clear();

	const open = new Map<string, vscode.TextDocument>();
	for (const other of vscode.workspace.textDocuments) open.set(canonicalPath(other.uri.fsPath), other);
	open.set(canonicalPath(document.uri.fsPath), document);

	const byFile = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
	byFile.set(document.uri.toString(), { uri: document.uri, items: [] });

	for (const error of parseCompilerOutput(output)) {
		const where = absoluteErrorPath(document, error.file);
		const named = error.file ? open.get(canonicalPath(where)) : document;
		const uri = named ? named.uri : vscode.Uri.file(where);
		const entry = byFile.get(uri.toString()) ?? { uri, items: [] };
		byFile.set(uri.toString(), entry);
		entry.items.push(
			new vscode.Diagnostic(
				lineRange(named, error.line),
				error.message,
				error.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
			),
		);
	}

	// set() replaces a file's whole list, so what this build does not name has
	// already lost its errors to the clear() above
	for (const entry of byFile.values()) collection.set(entry.uri, entry.items);
}

/** The line the compiler named, as a range, whether or not the file is open. */
function lineRange(document: vscode.TextDocument | undefined, line: number): vscode.Range {
	// a line of 0 is a problem with no line of its own: nothing to underline
	if (line <= 0) return noLineRange(document);
	const index = Math.max(line - 1, 0);
	if (document && index < document.lineCount) return document.lineAt(index).range;
	return new vscode.Range(index, 0, index, Number.MAX_SAFE_INTEGER);
}

/**
 * A range that marks no text, for a problem that names no line.
 *
 * A problem with no line of its own -- the loader refusing to start a program, a
 * link that failed -- still has to be given a range, and VS Code fills an empty
 * one in with the word it is in (`getWordRangeAtPosition`), so an empty range at
 * the start of a line would underline whatever word happens to be there and
 * point the reader at a line that is not at fault.  The range is therefore put
 * where no word encloses it: the problem is listed in the Problems pane and
 * nothing is underlined in the editor.  The top of the file is tried first, so
 * the entry sits as near the top as the file allows.
 */
function noLineRange(document: vscode.TextDocument | undefined): vscode.Range {
	if (!document) return new vscode.Range(0, 0, 0, 0);

	const places: vscode.Position[] = [new vscode.Position(0, 0)];
	// enough of the file to find a line that begins or ends between words, and
	// bounded so that a file of unbroken words cannot make this walk all of it
	const limit = Math.min(document.lineCount, 200);
	for (let line = 0; line < limit; line++) {
		const range = document.lineAt(line).range;
		places.push(range.start, range.end);
	}
	places.push(document.positionAt(document.getText().length));

	for (const place of places) {
		if (!document.getWordRangeAtPosition(place)) return new vscode.Range(place, place);
	}
	return new vscode.Range(0, 0, 0, 0);
}

/**
 * A program that will not run, in the Problems pane.
 *
 * The reason the loader gives -- a library it cannot find, above all -- is not
 * something the program printed, and it is not tied to a source line: it belongs
 * to the file as a whole, and the Problems pane is where a reader looks for
 * something to act on.  An empty message is a launch that worked, and takes away
 * the problem a failed one left.
 *
 * It goes in the compiler's own collection, so a build clears it the way a build
 * clears compiler errors: a file that has just been built has what this build
 * said about it and nothing left over from an earlier run.
 */
function reportProgramProblem(program: string, message: string): void {
	const collection = compilerDiagnostics;
	if (!collection) return;

	const uri = vscode.Uri.file(program);
	if (message === '') {
		collection.delete(uri);
		return;
	}

	const document = vscode.workspace.textDocuments.find((open) => open.uri.fsPath === program);
	collection.set(uri, [new vscode.Diagnostic(lineRange(document, 0), message, vscode.DiagnosticSeverity.Error)]);
}

/**
 * A launch that failed, said with the buttons the reader needs.
 *
 * The editor has a prompt of its own for a failed launch, and it is not used
 * here: it carries an `Open 'launch.json'` button, which is no use when what
 * went wrong is the program rather than the configuration, and it takes only one
 * button from the adapter besides, so it cannot offer both of these.  The launch
 * is failed without it (see `failQuietly`) and this is shown instead: OK for a
 * reader who has seen enough, and Show Logs for the whole account of what the
 * loader said, in the output channel this extension's logs go to.
 */
async function showLaunchAlert(message: string, details: string): Promise<void> {
	const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'OK', 'Show Logs');
	if (choice !== 'Show Logs') return;
	output.appendLine(`[PureBasic] ${new Date().toISOString()}`);
	output.appendLine(details);
	output.show(true);
}

/** A path with its symlinks resolved, for matching two ways of naming a file. */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** The line ending the document is written with, so an edit does not mix two. */
function eolOf(document: vscode.TextDocument): string {
	return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/**
 * A name the compiler printed, as a path.
 *
 * It is given the file to build rather than a directory, and an included file
 * comes back named beside it -- so a name that is not absolute belongs to that
 * file's own directory, not to wherever the editor happens to be running.
 */
function absoluteErrorPath(document: vscode.TextDocument, file: string): string {
	if (file === '' || isAbsolute(file)) return file;
	return join(dirname(document.uri.fsPath), file);
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
		{ label: 'Output path', description: c.get('outputPath', '') || 'beside the source', detail: 'Where the Compile save panel opens', key: 'outputPath', input: 'text' },
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
		const formats = ['windowed', 'console', 'library'];
		value = await vscode.window.showQuickPick(formats, {
			title: 'Executable format',
			placeHolder: c.get('executableFormat', 'windowed'),
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

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
	output = vscode.window.createOutputChannel('PureBasic');
	outputPanel = new DebugOutputPanel();
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(DebugOutputPanel.viewType, outputPanel, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	index = new PbIndex(config().maxFiles);
	compilerDiagnostics = vscode.languages.createDiagnosticCollection('purebasic');
	context.subscriptions.push(output, compilerDiagnostics);

	// Awaited, so activation is not "done" with the grammar half-written.  A
	// keyword file that cannot be read must never fail activation, hence the
	// catch: it costs the refresh, not the extension.
	try {
		await refreshKeywords(context, false);
	} catch (error) {
		trace(`keywords: ${String(error)}`);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('purebasic.run', () => runOrDebug()),
		vscode.commands.registerCommand('purebasic.compile', () => compileToExecutable()),
		// Two commands, not one toggle: the title-bar button's icon belongs to
		// the command, so turning it on and turning it off have to be separate
		// to be drawn differently.  Which one is offered follows the setting
		// itself, which the menu's `when` reads directly.
		vscode.commands.registerCommand('purebasic.debuggerOn', () => setDebugger(true)),
		vscode.commands.registerCommand('purebasic.debuggerOff', () => setDebugger(false)),
		vscode.commands.registerCommand('purebasic.compilerSettings', () => chooseCompilerSettings()),
		// the debugger: the adapter is the extension itself, driving the
		// command-line debugger that a -d build carries
		vscode.debug.registerDebugAdapterDescriptorFactory('purebasic', {
			createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(debugAdapter()),
		}),
		vscode.debug.registerDebugConfigurationProvider('purebasic', new DebugConfigurations()),
		vscode.commands.registerCommand('purebasic.debug', () => debugOpenFile()),
		vscode.commands.registerCommand('purebasic.runInTerminal', () => runInTerminalCommand()),
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
			const parsed = indexOf(document);
			const items = buildCompletions({
				document: parsed,
				workspaceSymbols: usableSymbols(parsed),
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

	/*
	 * The output panel opens itself for a PureBasic file.
	 *
	 * Asked of the open documents rather than of the event that has just fired,
	 * because a file being made is not a PureBasic file when it appears: an
	 * unsaved one has no language until it is given a name, so the event that
	 * matters is whichever comes next, and the answer is the same every time.
	 *
	 * Only on the way in, though: there is no telling a panel the reader has
	 * closed from one that was never open, so asking again on every edit would
	 * put it back on the next keystroke.
	 */
	let showing = false;
	const revealForPureBasic = () => {
		const wanted = vscode.workspace.textDocuments.some((open) => open.languageId === LANGUAGE);
		if (wanted && !showing) outputPanel.reveal();
		showing = wanted;
	};
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(() => revealForPureBasic()),
		vscode.workspace.onDidSaveTextDocument(() => revealForPureBasic()),
		vscode.workspace.onDidChangeTextDocument(() => revealForPureBasic()),
		vscode.window.onDidChangeActiveTextEditor(() => revealForPureBasic()),
	);
	revealForPureBasic();

	// keep the index in sync with edits
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (doc.languageId === LANGUAGE) indexOf(doc);
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.languageId === LANGUAGE) indexOf(event.document);
			// a line that has been typed over is no longer the line the compiler
			// stopped at, and should not keep its squiggle until the next build
			compilerDiagnostics?.delete(event.document.uri);
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			if (doc.languageId === LANGUAGE) index.remove(doc.uri.toString());
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			// only the settings the index is built from: a change to, say, the
			// trace level has no business walking the workspace again
			if (event.affectsConfiguration('purebasic.index')) {
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
			b.replace(line.range, `${lineText}${eolOf(document)}${body}${eolOf(document)}${base}${block.closers[0]}`),
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

	return { debugOutput: { visible: () => outputPanel.visible() } };
}


/*
 * Debugging.
 *
 * The adapter is a plain object of this extension's own -- there is no second
 * process -- and what it cannot do itself is handed to it here: building the
 * program, and putting that build's log in the terminal, both of which are the
 * same work the buttons do.
 */
function debugAdapter(): vscode.DebugAdapter {
	const session = new PureBasicDebugSession({
		trace: (message) => trace(message),
		build: (source, settings, target) => buildForDebug(source, settings, target),
		showBuild: (target, command, output, note) =>
			showBuildLog(target, command, output, note, dirname(target), hostPlatform()),
		output: (_stream, text) => outputPanel.append(text),
		problem: (program, message) => reportProgramProblem(program, message),
		alert: (message, details) => void showLaunchAlert(message, details),
	});

	const messages = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	session.onMessage = (message) => messages.fire(message as vscode.DebugProtocolMessage);

	return {
		onDidSendMessage: messages.event,
		handleMessage: (message) => session.handle(message as { command?: string }),
		dispose: () => {
			messages.dispose();
			session.dispose();
		},
	};
}

/** Build a program for debugging: the same build the buttons do, with the debugger in. */
async function buildForDebug(
	source: string,
	settings: CompilerSettings,
	target: string,
): Promise<{ ok: boolean; command: string; output: string }> {
	// a session started by the play button is started a moment after that button
	// built the very same executable: building it again would only be slower
	if (lastBuild && lastBuild.source === source && lastBuild.target === target && Date.now() - lastBuild.at < 15000) {
		const { ok, command, output } = lastBuild;
		return { ok, command, output };
	}

	const platform = hostPlatform();
	const compiler = resolveCompiler(settings.path, platform);
	const args = [...compilerArguments(settings, target, platform), source];
	const command = shellCommand([compiler, ...args], platform);
	trace(`debugger: ${command}`);

	await createFolder(dirname(target));
	const building = vscode.window.setStatusBarMessage(`PureBasic: building ${basename(source)}`);
	const result = await runCompiler(compiler, args, dirname(source));
	building.dispose();

	const document = vscode.workspace.textDocuments.find((open) => open.uri.fsPath === source);
	if (document) reportCompilerErrors(document, result.output);

	return { ok: result.code === 0, command, output: result.output };
}

/**
 * The launch configuration, filled in from what the buttons already know.
 *
 * A launch.json may name nothing but the source; everything else -- the compiler
 * settings, the platform, where the build goes -- is the extension's to supply,
 * and is the same for a session started from the command as for one started
 * from a file.
 */
class DebugConfigurations implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(): vscode.DebugConfiguration[] {
		return [newDebugConfiguration('${file}')];
	}

	resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
	): vscode.DebugConfiguration | undefined {
		if (!config.program) {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== LANGUAGE) {
				void vscode.window.showInformationMessage('PureBasic: open a .pb file to debug.');
				return undefined;
			}
			config.program = editor.document.uri.fsPath;
		}

		const settings = compilerSettings();
		const platform = hostPlatform();
		config.settings ??= settings;
		config.platform ??= platform;
		config.compiler ??= resolveCompiler(settings.path, platform);
		config.cwd ??= dirname(config.program);
		config.target ??= debugOutputFor(config.program, platform);
		return config;
	}
}

function newDebugConfiguration(program: string): vscode.DebugConfiguration {
	return { type: 'purebasic', request: 'launch', name: 'Debug PureBasic file', program };
}

/** `PureBasic: Debug` -- debug the file in the editor. */
async function debugOpenFile(): Promise<void> {
	const document = await compilableDocument();
	if (!document) return;
	await startDebugSession(document.uri.fsPath);
}

/**
 * Start a session for a file, if the debugger is switched on.
 *
 * The bug button in the title bar is the master switch for the whole
 * debugger, not just for the `-d` in the build: with it off there is no
 * debugger in the program to talk to, so a session is refused with a word
 * about why rather than failing somewhere further in.
 */
async function startDebugSession(program: string): Promise<void> {
	if (!compilerSettings().debugger) {
		void vscode.window.setStatusBarMessage(
			'PureBasic: the debugger is off -- turn it on with the bug button in the title bar',
			5000,
		);
		return;
	}
	await vscode.debug.startDebugging(undefined, newDebugConfiguration(program));
}


/*
 * The debug output panel.
 *
 * What the program itself prints -- `Debug` statements above all, which are
 * what a debugger is for -- goes to a view of its own in the secondary side
 * bar, beside the code rather than over it.  The compiler's messages stay in
 * the editor's terminal: they are the log of a build, not something the
 * program said.
 *
 * A run under the debugger fills this panel from the debugger's own output, and
 * a plain run fills it by being started here rather than in a terminal, which
 * is what makes both of them readable in one place.  A program that reads from
 * the keyboard still wants a terminal, and `PureBasic: Run in a Terminal` is
 * there for it.
 */
class DebugOutputPanel implements vscode.WebviewViewProvider {
	static readonly viewType = 'purebasic.debugOutput';
	/** The lines shown, replayed when the view is opened again. */
	private lines: string[] = [];
	private view: vscode.WebviewView | undefined;
	/** How to stop what is running, while something is. */
	private stopping: (() => void) | undefined;

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = outputHtml();
		view.webview.onDidReceiveMessage((message: { type?: string }) => {
			if (message.type === 'stop') this.stop();
			if (message.type === 'clear') this.clear();
		});
		view.onDidDispose(() => {
			this.view = undefined;
		});
		this.post({ type: 'reset' });
		for (const line of this.lines) this.post({ type: 'append', text: line });
	}

	/** A run is starting: the panel is emptied, named, and shown. */
	begin(name: string, stopping: () => void): void {
		this.stopping = stopping;
		this.lines = [];
		this.post({ type: 'reset', title: name });
		this.reveal();
	}

	/**
	 * Show the panel, if it is not showing already.
	 *
	 * There is no way to reveal a view without focusing it, so the caret is put
	 * back in the editor afterwards: the panel opens because a PureBasic file
	 * was opened, and that is where the writing is meant to happen.
	 */
	reveal(): void {
		if (this.view?.visible) return;
		void (async () => {
			try {
				// the view's own command rather than its container's: a view that
				// is the only one of its container has no container command
				await vscode.commands.executeCommand(`${DebugOutputPanel.viewType}.focus`);
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			} catch (error) {
				trace(`debugger: could not show the output panel: ${String(error)}`);
			}
		})();
	}

	append(text: string): void {
		this.write(text);
		this.post({ type: 'append', text });
	}

	/** The program is gone, and how it went. */
	finish(note: string): void {
		this.stopping = undefined;
		this.write(`${note}\n`);
		this.post({ type: 'note', text: note });
	}

	clear(): void {
		this.lines = [];
		this.post({ type: 'reset' });
	}

	/** Whether the panel is on screen. */
	visible(): boolean {
		return this.view?.visible === true;
	}

	/** Stop what is running, if anything is. */
	private stop(): void {
		const stopping = this.stopping;
		this.stopping = undefined;
		stopping?.();
	}

	private write(text: string): void {
		this.lines.push(text);
		// a long-running program prints a great deal: the panel keeps the end
		if (this.lines.length > 4000) this.lines.splice(0, this.lines.length - 4000);
	}

	private post(message: Record<string, unknown>): void {
		void this.view?.webview.postMessage(message);
	}
}

/** The panel's page: the output, and the two buttons. */
function outputHtml(): string {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
	body { margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); }
	#bar { position: sticky; top: 0; display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
	#title { flex: 1; opacity: .8; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	button { border: none; padding: 2px 8px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	pre { margin: 0; padding: 6px; white-space: pre-wrap; word-break: break-word; }
</style></head><body>
	<div id="bar"><span id="title"></span><button id="clear">Clear</button><button id="stop">Stop</button></div>
	<pre id="out"></pre>
	<script>
		const api = acquireVsCodeApi();
		const out = document.getElementById('out');
		const title = document.getElementById('title');
		const toBottom = () => window.scrollTo(0, document.body.scrollHeight);
		document.getElementById('clear').addEventListener('click', () => api.postMessage({ type: 'clear' }));
		document.getElementById('stop').addEventListener('click', () => api.postMessage({ type: 'stop' }));
		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'reset') {
				out.textContent = '';
				if (message.title !== undefined) title.textContent = message.title;
			} else if (message.type === 'append') {
				out.textContent += message.text;
				toBottom();
			} else if (message.type === 'note') {
				out.textContent += (out.textContent ? '\n' : '') + message.text + '\n';
				toBottom();
			}
		});
	</script>
</body></html>`;
}

/**
 * What this extension offers other extensions -- and the checks in this
 * repository, which ask the output panel whether it is showing.
 */
export interface ExtensionApi {
	debugOutput: { visible(): boolean };
}

export function deactivate(): void {
	index?.clear();
}
