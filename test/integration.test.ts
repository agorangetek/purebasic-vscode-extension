/*
 * End-to-end tests for the extension host wiring.
 *
 * The service layer is already covered directly; these tests bundle
 * src/extension.ts the way esbuild does for packaging, install a mock 'vscode'
 * module, activate the extension and drive the providers it registered.
 *
 * Needs esbuild, so it is skipped when devDependencies are not installed.
 *
 * Note: the sources are "erasable syntax only" TypeScript (no parameter
 * properties) because node runs them through type stripping -- that applies to
 * these mock classes too.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* eslint-disable @typescript-eslint/no-explicit-any */
let esbuild: any;
try {
	esbuild = require('esbuild');
} catch {
	esbuild = undefined;
}

/* ------------------------------------------------------------- vscode mock */

class Position {
	line: number;
	character: number;
	constructor(line: number, character: number) {
		this.line = line;
		this.character = character;
	}
}

class Range {
	start: Position;
	end: Position;
	/** vscode.Range is built either from two positions or from four numbers. */
	constructor(a: Position | number, b?: Position | number, c?: number, d?: number) {
		if (typeof a === 'number') {
			this.start = new Position(a, b as number);
			this.end = new Position(c as number, d as number);
		} else {
			this.start = a;
			this.end = b as Position;
		}
	}
}

/*
 * Files the extension indexes at activation: a chain (/ws/scratch.pb ->
 * lib/helpers.pb -> lib/deeper/more.pbi), a file nothing includes, and one
 * outside the workspace folder that only the include walk can reach.  Seeded
 * before `activate` runs so the real index and the real include walk are both
 * exercised, and named so they cannot collide with built-ins other tests assert.
 */
const workspaceFiles = new Map<string, string>([
	[
		'/ws/lib/helpers.pb',
		[
			'IncludeFile "deeper/more.pbi"',
			'Structure WsShape',
			'\twidth.i',
			'\theight.i',
			'\tList Parts.WsPart()',
			'EndStructure',
			'Structure WsPart',
			'\tlabel$',
			'EndStructure',
			'Procedure WsHelperGreet(name$)',
			'\tDebug name$',
			'EndProcedure',
			'WsHelperVersion.d = 1.0',
		].join('\n'),
	],
	['/ws/lib/deeper/more.pbi', ['Procedure WsDeepThing(x.i)', '\tProcedureReturn x', 'EndProcedure'].join('\n')],
	['/ws/other.pb', ['Procedure WsOtherThing(x.i)', '\tProcedureReturn x', 'EndProcedure'].join('\n')],
]);

/** Not returned by findFiles: only an IncludeFile chain can discover these. */
const outsideFiles = new Map<string, string>([
	['/shared/common.pbi', ['Procedure WsOutside()', '\tProcedureReturn 1', 'EndProcedure'].join('\n')],
]);

class Uri {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
	static file(path: string) {
		return new Uri(path);
	}
	static joinPath(uri: Uri, ...parts: string[]) {
		return new Uri([dirname(uri.path), ...parts].join('/'));
	}
	toString() {
		return `file://${this.path}`;
	}
}

class TextDocument {
	languageId = 'purebasic';
	path: string;
	text: string;
	constructor(path: string, text: string) {
		this.path = path;
		this.text = text;
	}
	get uri() {
		return Uri.file(this.path);
	}
	get lineCount() {
		return this.lines().length;
	}
	private lines() {
		return this.text.split('\n');
	}
	offsetAt(position: Position) {
		const lines = this.lines();
		let offset = 0;
		for (let i = 0; i < position.line; i++) offset += (lines[i] ?? '').length + 1;
		return offset + position.character;
	}
	positionAt(offset: number) {
		const lines = this.lines();
		let remaining = offset;
		for (let line = 0; line < lines.length; line++) {
			const length = (lines[line] ?? '').length;
			if (remaining <= length) return new Position(line, remaining);
			remaining -= length + 1;
		}
		return new Position(lines.length - 1, (lines[lines.length - 1] ?? '').length);
	}
	getText(range?: Range) {
		if (!range) return this.text;
		return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
	}
	lineAt(line: number) {
		const text = this.lines()[line] ?? '';
		return {
			// TextLine.lineNumber is the line's own index: zero-based, despite
			// the name.  Getting this wrong in the mock once hid a real
			// off-by-one in the caret, so it mirrors the API exactly.
			lineNumber: line,
			text,
			range: new Range(new Position(line, 0), new Position(line, text.length)),
		};
	}
	getWordRangeAtPosition(position: Position, regex: RegExp) {
		const line = this.lines()[position.line] ?? '';
		const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
		let match: RegExpExecArray | null;
		while ((match = re.exec(line)) !== null) {
			if (match.index <= position.character && position.character <= match.index + match[0].length) {
				return new Range(
					new Position(position.line, match.index),
					new Position(position.line, match.index + match[0].length),
				);
			}
			if (match[0].length === 0) re.lastIndex++;
		}
		return undefined;
	}
}

class SnippetString {
	value: string;
	constructor(value: string) {
		this.value = value;
	}
}

class MarkdownString {
	value: string;
	isTrusted = false;
	constructor(value: string) {
		this.value = value;
	}
}

interface CompletionItemLabel {
	label: string;
	detail?: string;
	description?: string;
}

class CompletionItem {
	/** The API accepts both forms; `new CompletionItem('x')` and the object form. */
	label: string | CompletionItemLabel;
	kind?: number;
	detail?: string;
	sortText?: string;
	filterText?: string;
	insertText?: unknown;
	documentation?: unknown;
	constructor(label: string | CompletionItemLabel, kind?: number) {
		this.label = label;
		this.kind = kind;
	}
}

/** The text VS Code shows for an item, from either label form. */
function shownLabel(item: CompletionItem): string {
	return typeof item.label === 'string' ? item.label : item.label.label;
}

/** The dimmed text after the label, or undefined when there is none. */
function shownDescription(item: CompletionItem): string | undefined {
	return typeof item.label === 'string' ? undefined : item.label.description;
}

class Hover {
	contents: MarkdownString;
	range?: unknown;
	constructor(contents: MarkdownString, range?: unknown) {
		this.contents = contents;
		this.range = range;
	}
}

class SignatureHelp {
	signatures: unknown[] = [];
	activeSignature = 0;
	activeParameter = 0;
}

class SignatureInformation {
	label: string;
	documentation?: MarkdownString;
	parameters: unknown[] = [];
	constructor(label: string, documentation?: MarkdownString) {
		this.label = label;
		this.documentation = documentation;
	}
}

class ParameterInformation {
	label: unknown;
	documentation?: MarkdownString;
	constructor(label: unknown, documentation?: MarkdownString) {
		this.label = label;
		this.documentation = documentation;
	}
}

class DocumentSymbol {
	name: string;
	detail: string;
	kind: number;
	range: unknown;
	selectionRange: unknown;
	constructor(name: string, detail: string, kind: number, range: unknown, selectionRange: unknown) {
		this.name = name;
		this.detail = detail;
		this.kind = kind;
		this.range = range;
		this.selectionRange = selectionRange;
	}
}

class Selection {
	anchor: Position;
	active: Position;
	constructor(anchor: Position, active: Position) {
		this.anchor = anchor;
		this.active = active;
	}
	get isEmpty() {
		return this.anchor.line === this.active.line && this.anchor.character === this.active.character;
	}
}

const disposable = { dispose() {} };

const registrations: Record<string, { selector: string; provider: any }[]> = {
	completion: [],
	hover: [],
	signature: [],
	symbols: [],
	formatting: [],
	rangeFormatting: [],
	onType: [],
};
const commands = new Map<string, (...args: unknown[]) => unknown>();
const executed: { id: string; args: unknown[] }[] = [];
const statusMessages: string[] = [];
const infoMessages: string[] = [];

const DEFAULT_CONFIG: Record<string, unknown> = {
	'completion.enable': true,
	'completion.keywords': true,
	'completion.builtins': true,
	'completion.snippets': true,
	'index.workspace': false,
	'index.maxFiles': 400,
	'format.canonicalCase': true,
	'trace.server': 'off',
};

const vscodeMock = {
	Position,
	Range,
	Uri,
	SnippetString,
	MarkdownString,
	CompletionItem,
	Hover,
	SignatureHelp,
	SignatureInformation,
	ParameterInformation,
	DocumentSymbol,
	Selection,
	TextEdit: {
		replace: (range: unknown, newText: string) => ({ range, newText }),
		insert: (position: Position, newText: string) => ({ range: new Range(position, position), newText }),
	},
	CompletionItemKind: {
		Function: 2,
		Method: 1,
		Variable: 5,
		Field: 4,
		Constant: 14,
		Struct: 21,
		Reference: 17,
		Module: 8,
		Snippet: 13,
		Keyword: 13,
	},
	SymbolKind: {
		Function: 11,
		Struct: 22,
		Namespace: 2,
		Enum: 9,
		Constant: 13,
		Field: 7,
		Key: 19,
		Variable: 12,
	},
	workspace: {
		textDocuments: [] as TextDocument[],
		getConfiguration: () => ({
			get: (key: string, fallback: unknown) => (key in DEFAULT_CONFIG ? DEFAULT_CONFIG[key] : fallback),
		}),
		findFiles: async () => [...workspaceFiles.keys()].map((path) => Uri.file(path)),
		fs: {
			readFile: async (uri: Uri) => {
				const text = workspaceFiles.get(uri.path) ?? outsideFiles.get(uri.path);
				if (text === undefined) throw new Error(`no such file: ${uri.path}`);
				return new TextEncoder().encode(text);
			},
		},
		onDidOpenTextDocument: () => disposable,
		onDidChangeTextDocument: () => disposable,
		onDidCloseTextDocument: () => disposable,
		onDidChangeConfiguration: () => disposable,
	},
	window: {
		activeTextEditor: undefined as any,
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: (message: string) => {
			infoMessages.push(message);
			return undefined;
		},
		setStatusBarMessage: (message: string) => {
			statusMessages.push(message);
		},
	},
	commands: {
		registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
			commands.set(id, handler);
			return disposable;
		},
		executeCommand: async (id: string, ...args: unknown[]) => {
			executed.push({ id, args });
			return undefined;
		},
	},
	languages: {
		registerCompletionItemProvider: (selector: string, provider: unknown) => {
			registrations.completion!.push({ selector, provider });
			return disposable;
		},
		registerHoverProvider: (selector: string, provider: unknown) => {
			registrations.hover!.push({ selector, provider });
			return disposable;
		},
		registerSignatureHelpProvider: (selector: string, provider: unknown) => {
			registrations.signature!.push({ selector, provider });
			return disposable;
		},
		registerDocumentSymbolProvider: (selector: string, provider: unknown) => {
			registrations.symbols!.push({ selector, provider });
			return disposable;
		},
		registerDocumentFormattingEditProvider: (selector: string, provider: unknown) => {
			registrations.formatting!.push({ selector, provider });
			return disposable;
		},
		registerDocumentRangeFormattingEditProvider: (selector: string, provider: unknown) => {
			registrations.rangeFormatting!.push({ selector, provider });
			return disposable;
		},
		registerOnTypeFormattingEditProvider: (selector: string, provider: unknown) => {
			registrations.onType!.push({ selector, provider });
			return disposable;
		},
	},
};

/* ------------------------------------------------------------------- setup */

const SAMPLE = [
	'; a demo module',
	'Structure Point',
	'\tx.i',
	'\ty.i',
	'EndStructure',
	'',
	'Procedure.d Add(a.d, b.d)',
	'\tProtected result.d',
	'\tresult = a + b',
	'\tProcedureReturn result',
	'EndProcedure',
	'',
	'#MAX = 10',
	'',
	'messagerequester("title", "text")',
	'',
	'Pro',
	'Poi',
].join('\n');

const document = new TextDocument('/ws/main.pb', SAMPLE);
const appliedEdits: { range: unknown; newText: string }[] = [];

const selections: Selection[] = [new Selection(new Position(0, 0), new Position(0, 0))];

const editor = {
	document: document as TextDocument,
	options: { insertSpaces: true, tabSize: 2 },
	get selection(): Selection {
		return selections[0]!;
	},
	get selections(): Selection[] {
		return selections;
	},
	set selections(value: Selection[]) {
		selections.length = 0;
		selections.push(...value);
	},
	edit: async (callback: (builder: { replace: (r: Range, t: string) => void }) => void) => {
		callback({
			replace: (range, newText) => {
				appliedEdits.push({ range, newText });
				// apply it, so the tests can see the document and caret the user
				// would be left with
				const start = editor.document.offsetAt(range.start);
				const end = editor.document.offsetAt(range.end);
				editor.document.text =
					editor.document.text.slice(0, start) + newText + editor.document.text.slice(end);
			},
		});
		return true;
	},
};

let activation: Promise<void> | undefined;

async function loadExtension(): Promise<void> {
	if (!esbuild) return;
	const dir = mkdtempSync(join(tmpdir(), 'pbvs-'));
	const outfile = join(dir, 'extension.cjs');
	await esbuild.build({
		entryPoints: [join(root, 'src/extension.ts')],
		bundle: true,
		outfile,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		external: ['vscode'],
		logLevel: 'silent',
	});

	const Module = require('node:module') as any;
	const original = Module._load;
	Module._load = function (request: string, ...rest: unknown[]) {
		if (request === 'vscode') return vscodeMock;
		return original.call(this, request, ...rest);
	};

	const bundle = require(outfile) as { activate: (ctx: unknown) => void };
	vscodeMock.workspace.textDocuments.push(document);
	vscodeMock.window.activeTextEditor = editor;
	bundle.activate({ subscriptions: [], workspaceState: {} });
}

const skip = !esbuild && 'esbuild not installed';

test('integration: extension host wiring', { skip }, async (t) => {
	activation ??= loadExtension();
	await activation;

	await t.test('registers a provider for every language feature', () => {
		for (const group of [
			'completion',
			'hover',
			'signature',
			'symbols',
			'formatting',
			'rangeFormatting',
			'onType',
		] as const) {
			assert.equal(registrations[group]!.length, 1, `${group} provider`);
			assert.equal(registrations[group]![0]!.selector, 'purebasic');
		}
		assert.ok(commands.has('purebasic.reindex'));
		assert.ok(commands.has('purebasic.showIndexStats'));
		assert.ok(commands.has('purebasic.formatText'));
	});

	await t.test('completes commands, keywords and symbols once the name is long enough', () => {
		const provider = registrations.completion[0]!.provider;
		const labelsAt = (line: number, character: number) =>
			(provider.provideCompletionItems(document, new Position(line, character)) as CompletionItem[]).map(
				(i) => i.label,
			);

		assert.ok(labelsAt(8, 4).includes('result'), 'a local, typed "res"');
		assert.ok(labelsAt(14, 3).includes('MessageRequester'), 'a library command, typed "mes"');
		assert.ok(labelsAt(16, 3).includes('Procedure'), 'a keyword, typed "Pro"');
		assert.ok(labelsAt(17, 3).includes('Point'), 'a structure, typed "Poi"');
	});

	await t.test('waits for three characters before opening the list', () => {
		const provider = registrations.completion[0]!.provider;
		const at = (line: number, character: number) =>
			provider.provideCompletionItems(document, new Position(line, character)) as CompletionItem[];

		assert.equal(at(14, 2).length, 0, 'two characters offers nothing');
		assert.ok(at(14, 3).length > 0, 'three characters opens the list');

		// a type list after a dot is asked for by the dot, so the minimum does
		// not apply to it -- with or without the editor saying so
		const dotDoc = new TextDocument(
			'/ws/dot.pb',
			['Structure Point', '\tx.i', 'EndStructure', 'Procedure p()', '\tpt.', 'EndProcedure'].join('\n'),
		);
		assert.ok(
			provider.provideCompletionItems(dotDoc, new Position(4, 4)).length > 0,
			'the list after a dot appears straight away',
		);
		assert.ok(
			provider.provideCompletionItems(dotDoc, new Position(4, 4), undefined, {
				triggerKind: 1,
				triggerCharacter: '.',
			}).length > 0,
			'and when the editor reports the trigger character',
		);
	});

	await t.test('three typed characters bring the list up, with results', () => {
		const provider = registrations.completion[0]!.provider;
		const doc = new TextDocument(
			'/ws/str.pb',
			['Procedure Test()', '\tstr', 'EndProcedure'].join('\n'),
		);

		const labels = (character: number) =>
			(provider.provideCompletionItems(doc, new Position(1, character)) as CompletionItem[]).map(
				(i) => i.label,
			);

		assert.equal(labels(2).length, 0, 'two characters is still too few');
		const three = labels(4); // "str"
		assert.ok(three.includes('Str'), `expected Str among ${three.join(', ')}`);
		assert.ok(three.includes('Structure'), 'and the keyword that starts the same way');

		// the editor filters on filterText a second time, so it has to carry the
		// typed case and still match
		const str = (provider.provideCompletionItems(doc, new Position(1, 4)) as CompletionItem[]).find(
			(i) => i.label === 'Str',
		);
		assert.equal(str?.filterText, 'str');
	});

	await t.test('the diagnostic command reports what the provider would return', async () => {
		const doc = new TextDocument('/ws/diag.pb', ['Procedure Test()', '\tstr', 'EndProcedure'].join('\n'));
		editor.document = doc;
		editor.selections = [new Selection(new Position(1, 4), new Position(1, 4))];
		infoMessages.length = 0;

		await commands.get('purebasic.diagnoseCompletion')!();

		const report = infoMessages[0] ?? '';
		assert.match(report, /typed "str" -> \d+ items/, report);
		assert.doesNotMatch(report, /-> 0 items/, report);
		assert.match(report, /minChars 3/);
	});

	await t.test('offers a call snippet for a command with parameters', () => {
		const provider = registrations.completion[0]!.provider;
		const items = provider.provideCompletionItems(document, new Position(14, 4)) as CompletionItem[];
		const message = items.find((i) => i.label === 'MessageRequester');
		assert.ok(message, `expected MessageRequester among ${items.map((i) => i.label).join(', ')}`);
		assert.ok(message.insertText instanceof SnippetString);
		assert.match((message.insertText as SnippetString).value, /^MessageRequester\(\$\{1:/);
	});

	await t.test('hovers a command with its manual signature', () => {
		const provider = registrations.hover[0]!.provider;
		const hover = provider.provideHover(document, new Position(14, 4));
		assert.ok(hover instanceof Hover);
		assert.match((hover.contents as MarkdownString).value, /MessageRequester/);
	});

	await t.test('signature help tracks the active parameter', () => {
		const provider = registrations.signature[0]!.provider;
		const help = provider.provideSignatureHelp(document, new Position(14, 26));
		assert.ok(help instanceof SignatureHelp);
		assert.match((help.signatures[0] as SignatureInformation).label, /^MessageRequester\(/);
		assert.equal(help.activeParameter, 1);
	});

	await t.test('the outline lists top-level declarations only', () => {
		const provider = registrations.symbols[0]!.provider;
		const symbols = provider.provideDocumentSymbols(document) as DocumentSymbol[];
		const names = symbols.map((s) => s.name);
		assert.ok(names.includes('Add'), names.join(', '));
		assert.ok(names.includes('Point'));
		assert.ok(names.includes('#MAX'));
		assert.ok(!names.includes('result'), 'locals stay out of the outline');
	});

	await t.test('Enter finishes a block opener and leaves the caret in the body', async () => {
		const doc = new TextDocument('/ws/enter.pb', 'procedure test()');
		editor.document = doc;
		editor.selections = [new Selection(new Position(0, 16), new Position(0, 16))];
		executed.length = 0;

		await commands.get('purebasic.newline')!();

		assert.equal(doc.text, 'Procedure test()\n  \nEndProcedure');
		assert.equal(editor.selections[0]!.active.line, 1, 'the caret is on the body line');
		assert.equal(editor.selections[0]!.active.character, 2, 'past the indentation');
		assert.deepEqual(executed, [], 'the editor\'s own Enter is not used');
	});

	await t.test('Enter anywhere else falls through to the editor', async () => {
		// a declaration with no parentheses yet: re-cased, but not expanded
		const half = new TextDocument('/ws/half.pb', 'procedure test');
		editor.document = half;
		editor.selections = [new Selection(new Position(0, 14), new Position(0, 14))];
		executed.length = 0;
		await commands.get('purebasic.newline')!();
		assert.equal(half.text, 'Procedure test', 'no terminator before the signature is closed');
		assert.deepEqual(executed.map((e) => e.id), ['default:type']);

		// a line that opens nothing, and the middle of a line
		for (const [text, column] of [
			['x = 1', 5],
			['Procedure test()', 10],
		] as const) {
			const doc = new TextDocument('/ws/plain.pb', text);
			editor.document = doc;
			editor.selections = [new Selection(new Position(0, column), new Position(0, column))];
			executed.length = 0;
			await commands.get('purebasic.newline')!();
			assert.deepEqual(executed.map((e) => e.id), ['default:type'], text);
			assert.equal(doc.text, text, 'nothing was rewritten');
		}
	});

	await t.test('a space capitalises the keyword it finishes', () => {
		const provider = registrations.onType[0]!.provider;
		const at = (text: string) =>
			provider.provideOnTypeFormattingEdits(
				new TextDocument('/ws/space.pb', text),
				new Position(0, text.length),
				' ',
			) as { range: Range; newText: string }[] | undefined;

		// only the word the space finished is replaced
		const typed = at('procedure ');
		assert.equal(typed?.length, 1);
		assert.equal(typed![0]!.newText, 'Procedure');
		assert.equal(typed![0]!.range.start.character, 0);
		assert.equal(typed![0]!.range.end.character, 9);

		assert.equal(at('  if ')![0]!.newText, 'If', 'the indentation is left alone');
		assert.equal(at('  foreach ')![0]!.newText, 'ForEach');
		assert.equal(at('if x = 1 and ')![0]!.newText, 'And');

		// already canonical, not a keyword, or not code at all
		assert.equal(at('If '), undefined);
		assert.equal(at('x '), undefined);
		assert.equal(at('print '), undefined, 'a library command is not re-cased as you type');
		assert.equal(at('; if '), undefined, 'a comment is not code');
		assert.equal(at('s = "if '), undefined, 'nor is a string');
		assert.equal(at('foo() '), undefined);
	});

	await t.test('a closing paren re-cases the line it finishes', () => {
		const provider = registrations.onType[0]!.provider;
		const doc = new TextDocument('/ws/paren.pb', ['procedure test()', ''].join('\n'));
		const edits = provider.provideOnTypeFormattingEdits(doc, new Position(0, 16), ')') as {
			newText: string;
		}[];

		assert.equal(edits?.[0]?.newText, 'Procedure test()');
	});

	await t.test('Format Text restores the canonical spelling', async () => {
		const doc = new TextDocument(
			'/ws/case.pb',
			['procedure.d area(w.d, h.d)', '\tprocedurereturn w * h', 'endprocedure'].join('\n'),
		);
		editor.document = doc;
		appliedEdits.length = 0;

		await commands.get('purebasic.formatText')!();

		assert.equal(appliedEdits.length, 1, 'expected one whole-document replacement');
		assert.equal(
			appliedEdits[0]!.newText,
			['Procedure.d area(w.d, h.d)', '\tProcedureReturn w * h', 'EndProcedure'].join('\n'),
		);
		assert.ok(statusMessages.some((m) => /re-cased/.test(m)));
	});
});

test('integration: only files joined by IncludeFile share symbols', { skip }, async (t) => {
	// the mock has workspace indexing off; this is the feature that needs it
	DEFAULT_CONFIG['index.workspace'] = true;
	activation ??= loadExtension();
	await activation;

	const at = (document: TextDocument, line: number, character: number) =>
		registrations.completion[0]!.provider.provideCompletionItems(
			document,
			new Position(line, character),
		) as CompletionItem[];
	const labels = (items: CompletionItem[]) => items.map(shownLabel).join(', ');
	const lineFor = (word: string) => `\t${word}`;

	// /ws/scratch.pb includes lib/helpers.pb, which includes lib/deeper/more.pbi
	const scratch = new TextDocument(
		'/ws/scratch.pb',
		[
			'IncludeFile "lib/helpers.pb"',
			'IncludeFile "../shared/common.pbi"',
			'Procedure ScratchMain()',
			lineFor('WsHel'),
			lineFor('WsDee'),
			lineFor('WsOth'),
			lineFor('WsOut'),
			'\tDefine s.WsShape',
			'\ts\\',
			'\ts\\Parts()\\',
			'EndProcedure',
		].join('\n'),
	);

	await t.test('a file named by IncludeFile contributes, with its file on the item', async () => {
		// the include walk starts from the open documents, so scratch is one
		if (!vscodeMock.workspace.textDocuments.includes(scratch)) {
			vscodeMock.workspace.textDocuments.push(scratch);
		}
		await commands.get('purebasic.reindex')!();

		const items = at(scratch, 3, 7);
		const greet = items.find((i) => shownLabel(i) === 'WsHelperGreet');

		assert.ok(greet, `expected WsHelperGreet among ${labels(items)}`);
		assert.equal(
			shownDescription(greet),
			'helpers.pb',
			'the file that defines the symbol is shown after the label',
		);
		assert.match(String(greet.sortText), /^2helpers\.pb/, 'the file name keeps one file together');
	});

	await t.test('the chain is followed in both directions and transitively', async () => {
		// scratch -> helpers.pb -> deeper/more.pbi
		const deep = at(scratch, 4, 7);
		assert.ok(
			deep.some((i) => shownLabel(i) === 'WsDeepThing'),
			`an included file contributes through the chain, got ${labels(deep)}`,
		);

		// editing the deepest file, whose symbols come from the file that includes it
		const more = new TextDocument(
			'/ws/lib/deeper/more.pbi',
			['Procedure WsDeepThing(x.i)', lineFor('WsHelperGreet'), 'EndProcedure'].join('\n'),
		);
		const up = at(more, 1, 15);
		assert.ok(
			up.some((i) => shownLabel(i) === 'WsHelperGreet'),
			`a file included by another sees that file, got ${labels(up)}`,
		);
	});

	await t.test('a file no include reaches is not offered', async () => {
		const items = at(scratch, 5, 7);
		assert.ok(
			!items.some((i) => shownLabel(i) === 'WsOtherThing'),
			`/ws/other.pb is not included, got ${labels(items)}`,
		);

		// the file is indexed all the same: a file that includes it does see it
		const other = new TextDocument(
			'/ws/usesother.pb',
			['IncludeFile "other.pb"', 'Procedure UsesOther()', lineFor('WsOth'), 'EndProcedure'].join('\n'),
		);
		const viaInclude = at(other, 2, 7);
		assert.ok(
			viaInclude.some((i) => shownLabel(i) === 'WsOtherThing'),
			`including /ws/other.pb makes it contribute, got ${labels(viaInclude)}`,
		);
	});

	await t.test('the members of a structure from an included file are offered', () => {
		const items = registrations.completion[0]!.provider.provideCompletionItems(
			scratch,
			new Position(8, 3),
			{ triggerCharacter: '\\' },
		) as CompletionItem[];
		const labels = items.map(shownLabel);

		assert.ok(labels.includes('width'), `expected width among ${labels.join(', ')}`);
		assert.ok(labels.includes('height'), `expected height among ${labels.join(', ')}`);
		const width = items.find((i) => shownLabel(i) === 'width');
		assert.equal(shownDescription(width!), 'helpers.pb', 'a member says which file it came from');
		assert.ok(
			!labels.includes('WsHelperGreet'),
			'a member list holds members, not the names you type anywhere',
		);

		// a List member is inserted with its parentheses, and its element can be
		// stepped into
		const parts = items.find((i) => shownLabel(i) === 'Parts');
		assert.ok(parts, `expected Parts among ${labels.join(', ')}`);
		assert.equal(parts.insertText, 'Parts()', 'a List member is inserted with its parentheses');

		const element = registrations.completion[0]!.provider.provideCompletionItems(
			scratch,
			new Position(9, 11),
			{ triggerCharacter: '\\' },
		) as CompletionItem[];
		assert.ok(
			element.map(shownLabel).includes('label$'),
			`expected the element members, got ${element.map(shownLabel).join(', ')}`,
		);
	});

	await t.test('an included file outside the workspace folder is read from disk', async () => {
		const items = at(scratch, 6, 7);
		const outside = items.find((i) => shownLabel(i) === 'WsOutside');

		assert.ok(outside, `expected WsOutside among ${labels(items)}`);
		assert.equal(shownDescription(outside), 'common.pbi');
	});
});
