/*
 * VS Code entry point.
 *
 * All the language logic lives in ./service (editor-agnostic, unit-tested);
 * this file only translates between those plain objects and the vscode API.
 */
import * as vscode from 'vscode';
import { allBlocks, builtinCount, builtinSource, canonicalKeyword } from './service/builtins.ts';
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
		trace: c.get<string>('trace.server', 'off'),
	};
}

function trace(message: string): void {
	if (config().trace === 'off') return;
	output.appendLine(`[${new Date().toISOString()}] ${message}`);
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

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('PureBasic');
	index = new PbIndex(config().maxFiles);
	context.subscriptions.push(output);

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
			const word =
				/(\*|@|\?)?[A-Za-z_]\w*\$?$/.exec(line.slice(0, position.character))?.[0] ?? '';
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
					const word =
						/(\*|@|\?)?[A-Za-z_]\w*\$?$/.exec(line.slice(0, position.character))?.[0] ?? '';

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
