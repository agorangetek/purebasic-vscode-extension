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

class CompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	sortText?: string;
	filterText?: string;
	insertText?: unknown;
	documentation?: unknown;
	constructor(label: string, kind?: number) {
		this.label = label;
		this.kind = kind;
	}
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

const disposable = { dispose() {} };

const registrations: Record<string, { selector: string; provider: any }[]> = {
	completion: [],
	hover: [],
	signature: [],
	symbols: [],
	formatting: [],
	rangeFormatting: [],
};
const commands = new Map<string, (...args: unknown[]) => unknown>();
const statusMessages: string[] = [];

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
	TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
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
		findFiles: async () => [],
		fs: { readFile: async () => new Uint8Array() },
		onDidOpenTextDocument: () => disposable,
		onDidChangeTextDocument: () => disposable,
		onDidCloseTextDocument: () => disposable,
		onDidChangeConfiguration: () => disposable,
	},
	window: {
		activeTextEditor: undefined as any,
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showInformationMessage: () => undefined,
		setStatusBarMessage: (message: string) => {
			statusMessages.push(message);
		},
	},
	commands: {
		registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
			commands.set(id, handler);
			return disposable;
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
].join('\n');

const document = new TextDocument('/ws/main.pb', SAMPLE);
const appliedEdits: { range: unknown; newText: string }[] = [];

const editor = {
	document: document as TextDocument,
	selections: [{ isEmpty: true }],
	edit: async (callback: (builder: { replace: (r: unknown, t: string) => void }) => void) => {
		callback({ replace: (range, newText) => appliedEdits.push({ range, newText }) });
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
		] as const) {
			assert.equal(registrations[group]!.length, 1, `${group} provider`);
			assert.equal(registrations[group]![0]!.selector, 'purebasic');
		}
		assert.ok(commands.has('purebasic.reindex'));
		assert.ok(commands.has('purebasic.showIndexStats'));
		assert.ok(commands.has('purebasic.formatText'));
	});

	await t.test('completes library commands, keywords and user symbols', () => {
		const provider = registrations.completion[0]!.provider;
		const items = provider.provideCompletionItems(document, new Position(8, 1)) as CompletionItem[];
		const found = new Set(items.map((i) => i.label));
		assert.ok(found.has('result'), `expected the local among ${items.length} items`);
		assert.ok(found.has('Add'));
		assert.ok(found.has('Point'));
		assert.ok(found.has('MessageRequester'));
		assert.ok(found.has('Procedure'));
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
