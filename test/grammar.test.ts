/*
 * Tokenization tests for the TextMate grammar.
 *
 * Syntax highlighting is the grammar's whole job: a theme can only colour what
 * the grammar scopes, so a token that matches no rule silently falls back to
 * the editor's default foreground.  These tests tokenize real PureBasic with
 * the same engine the editor uses.
 *
 * Needs vscode-textmate/vscode-oniguruma, so they are skipped when
 * devDependencies are not installed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* eslint-disable @typescript-eslint/no-explicit-any */
interface OnigLib {
	loadWASM(data: ArrayBuffer): Promise<void>;
	OnigScanner: new (patterns: string[]) => unknown;
	OnigString: new (s: string) => unknown;
}
interface Textmate {
	INITIAL: unknown;
	Registry: new (options: unknown) => { loadGrammar(scope: string): Promise<Grammar> };
	parseRawGrammar(text: string, name: string): unknown;
}
interface Grammar {
	tokenizeLine(
		line: string,
		stack: unknown,
	): { tokens: { startIndex: number; endIndex: number; scopes: string[] }[]; ruleStack: unknown };
}

let onig: OnigLib | undefined;
let vsctm: Textmate | undefined;
try {
	onig = require('vscode-oniguruma') as OnigLib;
	vsctm = require('vscode-textmate') as Textmate;
} catch {
	onig = undefined;
}

interface Token {
	text: string;
	scopes: string[];
}

async function tokenize(text: string): Promise<Token[][]> {
	await onig!.loadWASM(
		readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer,
	);
	const registry = new vsctm!.Registry({
		onigLib: Promise.resolve({
			createOnigScanner: (patterns: string[]) => new onig!.OnigScanner(patterns),
			createOnigString: (s: string) => new onig!.OnigString(s),
		}),
		loadGrammar: async (scopeName: string) =>
			scopeName === 'source.purebasic'
				? vsctm!.parseRawGrammar(
						readFileSync(join(root, 'syntaxes', 'purebasic.tmLanguage.json'), 'utf8'),
						'purebasic.tmLanguage.json',
					)
				: null,
	});
	const grammar = await registry.loadGrammar('source.purebasic');

	const lines = text.split('\n');
	const out: Token[][] = [];
	let stack = vsctm!.INITIAL;
	for (const line of lines) {
		const result = grammar.tokenizeLine(line, stack);
		stack = result.ruleStack;
		out.push(
			result.tokens.map((t) => ({
				text: line.slice(t.startIndex, t.endIndex),
				scopes: t.scopes.filter((s: string) => s !== 'source.purebasic'),
			})),
		);
	}
	return out;
}

/** Every token whose text contains `needle`, as line/token pairs. */
function occurrences(lines: Token[][], needle: string): { line: number; token: Token }[] {
	const found: { line: number; token: Token }[] = [];
	lines.forEach((tokens, line) => {
		for (const token of tokens) {
			if (token.text.includes(needle)) found.push({ line, token });
		}
	});
	return found;
}

const skip = !onig && 'vscode-textmate not installed';

function assertScoped(lines: Token[][], needle: string, expected: RegExp, label: string): void {
	const hits = occurrences(lines, needle).filter(({ token }) => token.text.trim() === needle);
	assert.ok(hits.length > 0, `${label}: "${needle}" did not tokenize at all`);
	for (const { line, token } of hits) {
		assert.ok(
			token.scopes.some((s) => expected.test(s)),
			`${label}: line ${line + 1} "${needle}" has ${token.scopes.join(' ') || 'no scope'}`,
		);
	}
}

test('comments, strings and numbers are scoped', { skip }, async () => {
	const lines = await tokenize(
		[
			'; a note about Procedure',
			'MessageRequester("endprocedure", "x")',
			's = ~"a \\" b"',
			'n = $FF + %1010 + 12',
		].join('\n'),
	);

	const comment = occurrences(lines, '; a note about Procedure')[0]?.token;
	assert.ok(comment?.scopes.includes('comment.line.semicolon.purebasic'), 'a ; comment');

	// the contents of a string are a string, even when they spell a keyword
	const string = occurrences(lines, 'endprocedure').find(({ line }) => line === 1)?.token;
	assert.ok(string?.scopes.includes('string.quoted.double.purebasic'), 'a plain string');
	assert.ok(
		!string?.scopes.some((sc) => sc.startsWith('keyword')),
		'a keyword inside a string stays a string',
	);

	const escape = occurrences(lines, '~"').find(({ line }) => line === 2)?.token;
	assert.ok(
		escape?.scopes.includes('string.quoted.double.escape.purebasic'),
		'an escape string opens a string',
	);
	const escaped = occurrences(lines, '\\"').find(({ line }) => line === 2)?.token;
	assert.ok(
		escaped?.scopes.includes('constant.character.escape.purebasic'),
		'an escaped quote is an escape',
	);

	for (const number of ['$FF', '%1010', '12']) {
		assertScoped(lines, number, /^constant\.numeric/, 'number');
	}
});

test('constants and keywords are scoped', { skip }, async () => {
	const lines = await tokenize(['#MAX = 10', 'x = #PB_Event_CloseWindow', 'EndProcedure', 'ReDim a.i(2)', 'ForEach x()'].join('\n'));

	assertScoped(lines, '#MAX', /^constant\.other/, 'user constant');
	assertScoped(lines, '#PB_Event_CloseWindow', /^support\.constant/, 'library constant');
	assertScoped(lines, 'EndProcedure', /^keyword\./, 'a terminator');
	assertScoped(lines, 'ReDim', /^keyword\./, 'ReDim');
	assertScoped(lines, 'ForEach', /^keyword\.control/, 'ForEach');
});

test('library commands keep their own scope, user calls are functions', { skip }, async () => {
	const lines = await tokenize(['MessageRequester("t", "m")', 'r = Abs(-1)', 'MyUserProc(1)'].join('\n'));

	assertScoped(lines, 'MessageRequester', /^support\.function\./, 'a library command');
	assertScoped(lines, 'Abs', /^support\.function\.math/, 'a command from a known library');
	assertScoped(lines, 'MyUserProc', /^entity\.name\.function/, 'an unknown call');
});

test('declarations name their procedure, structure and module', { skip }, async () => {
	const lines = await tokenize(
		['Procedure.d Area(w.d, h.d)', 'Structure Point', 'EndStructure', 'Module Helper'].join('\n'),
	);
	assertScoped(lines, 'Area', /^entity\.name\.function/, 'a procedure name');
	assertScoped(lines, 'Point', /^entity\.name\.type/, 'a structure name');
	assertScoped(lines, 'Helper', /^entity\.name\.type/, 'a module name');
});

test('members, sigils and labels are scoped', { skip }, async () => {
	const lines = await tokenize(
		['pt\\x = 1', 'Helper::DoIt()', '*pBuffer = AllocateMemory(4)', 'p = @MyProc()', 'd = ?data', 'top:', '! mov eax, 1'].join(
			'\n',
		),
	);
	assertScoped(lines, '\\x', /^variable\.other\.member/, 'member access');
	assertScoped(lines, '*pBuffer', /^variable\.other\.pointer/, 'pointer variable');
	assertScoped(lines, '@MyProc', /^variable\.other\.reference/, 'procedure address');
	assertScoped(lines, '?data', /^variable\.other\.label-reference/, 'data label reference');
	assertScoped(lines, 'top', /^entity\.name\.label/, 'a label');
	assertScoped(lines, '! mov eax, 1', /^meta\.embedded\.asm/, 'inline assembly');

	assertScoped(lines, 'Helper', /^entity\.name\.namespace/, 'a module qualifier');
	assertScoped(lines, '::DoIt', /^variable\.other\.member/, 'a module member');
});

test('a type suffix is scoped as a type, a decimal point is a number', { skip }, async () => {
	const lines = await tokenize(['x.d = 1.5', 'name$ = "hi"'].join('\n'));
	assertScoped(lines, 'd', /^storage\.type/, 'the .d suffix');
	assertScoped(lines, '1.5', /^constant\.numeric/, 'a decimal literal');
});

test('a procedure return type is coloured as a type, not as the name', { skip }, async () => {
	const lines = await tokenize(
		['Procedure.d Area(w.d, h.d)', 'Declare.i Test(*p.Point)', 'Prototype.i Callback(x.i)'].join('\n'),
	);

	// the suffix after Procedure/Declare/Prototype is the return type
	for (const [line, suffix] of [
		[0, 'd'],
		[1, 'i'],
		[2, 'i'],
	] as const) {
		const tokens = lines[line]!.filter((t) => t.text === suffix);
		assert.ok(tokens.length > 0, `line ${line + 1}: no "${suffix}" token`);
		for (const token of tokens) {
			assert.ok(
				token.scopes.includes('storage.type.purebasic'),
				`line ${line + 1}: ".${suffix}" should be a type, got ${token.scopes.join(' ') || 'no scope'}`,
			);
			assert.ok(
				!token.scopes.some((sc) => sc.startsWith('entity.name')),
				`line ${line + 1}: ".${suffix}" must not be coloured like the procedure name`,
			);
		}
	}

	assertScoped(lines, 'Area', /^entity\.name\.function/, 'a procedure name');
	assertScoped(lines, 'Test', /^entity\.name\.function/, 'a declared name');
	assertScoped(lines, 'Callback', /^entity\.name\.function/, 'a prototype name');
});

/*
 * VS Code chooses which editor.quickSuggestions entry applies to a keystroke by
 * deriving a "standard token type" from the INNERMOST scope of the token at the
 * caret, matching /\b(comment|string|regex|regexp)\b/ (getStandardTokenType in
 * the editor's tokenMetadata).  Strings and comments default to "off", so a code
 * scope that contains one of those words as a whole word stops the suggestion
 * widget from opening while typing.  The String library used to be scoped
 * support.function.string.purebasic, so typing `str` classified the caret as a
 * string and the list never appeared -- while `procedure` (keyword, "other")
 * worked.  These tests keep every code scope out of that trap.
 */
const RESERVED_TOKEN_TYPE = /\b(comment|string|regex|regexp)\b/;

/** The scope VS Code reads the quickSuggestions category from. */
function quickSuggestionsCategory(token: Token): string {
	const innermost = token.scopes[token.scopes.length - 1] ?? 'source.purebasic';
	return innermost.match(RESERVED_TOKEN_TYPE)?.[1] ?? 'other';
}

test('no built-in command or keyword is tokenized as a string or a comment', { skip }, async () => {
	const data = JSON.parse(
		readFileSync(join(root, 'src', 'data', 'pb-builtins.json'), 'utf8'),
	) as { items: { name: string }[]; keywords: string[] };
	const names = [...data.items.map((item) => item.name), ...data.keywords];

	const lines = await tokenize(names.join('\n'));
	const offenders: string[] = [];
	lines.forEach((tokens, line) => {
		for (const token of tokens) {
			if (token.text.trim() !== names[line]) continue;
			const category = quickSuggestionsCategory(token);
			if (category !== 'other') offenders.push(`${names[line]} -> ${token.scopes.join(' ')}`);
		}
	});

	assert.deepEqual(
		offenders,
		[],
		`typing these names would suppress the suggestion popup: ${offenders.join(', ')}`,
	);
});

test('a String library command prefix still pops up suggestions', { skip }, async () => {
	const lines = await tokenize(
		['Procedure Test()', '\tstr', '\tstrd', '\tleft', '\tmid', '\tlen', 'EndProcedure'].join('\n'),
	);

	for (const name of ['str', 'strd', 'left', 'mid', 'len']) {
		const token = occurrences(lines, name).find(({ token }) => token.text.trim() === name)?.token;
		assert.ok(token, `${name} did not tokenize`);
		assert.equal(
			quickSuggestionsCategory(token),
			'other',
			`"${name}" scopes as ${token.scopes.join(' ')}, so the editor would treat it as a string/comment and never pop up`,
		);
		assert.ok(
			token.scopes.some((s) => s.startsWith('support.function.')),
			`"${name}" should still be a library command, got ${token.scopes.join(' ') || 'no scope'}`,
		);
	}
});

test('string and comment literals are still classified as such', { skip }, async () => {
	const lines = await tokenize(['Debug "MessageRequester"', '; MessageRequester'].join('\n'));

	const literal = occurrences(lines, 'MessageRequester').find(({ line }) => line === 0)?.token;
	const comment = occurrences(lines, 'MessageRequester').find(({ line }) => line === 1)?.token;
	assert.ok(literal && comment, 'the sample did not tokenize');

	assert.equal(quickSuggestionsCategory(literal), 'string');
	assert.equal(quickSuggestionsCategory(comment), 'comment');
});

test('a reference carries its sigil, even before the name is typed', { skip }, async () => {
	const lines = await tokenize(
		['@ThreadProcedure1()', 'CreateThread(@ThreadProcedure1(), 0)', '@', '@*p', 'x = a * b'].join('\n'),
	);

	// the whole reference is one token, sigil included
	const reference = occurrences(lines, '@ThreadProcedure1');
	assert.ok(reference.length >= 2, 'the references should tokenize');
	for (const { token } of reference) {
		assert.equal(token.text, '@ThreadProcedure1', 'the @ belongs to the token');
		assert.ok(token.scopes.includes('variable.other.reference.purebasic'), 'and to the scope');
	}

	// a sigil on its own is not left uncoloured
	const bare = lines[2]!.find((t) => t.text === '@');
	assert.ok(bare, 'the bare @ should tokenize');
	assert.ok(
		bare.scopes.includes('variable.other.reference.purebasic'),
		`a bare @ should be scoped, got ${bare.scopes.join(' ') || 'no scope'}`,
	);
	const beforePointer = lines[3]!.find((t) => t.text === '@');
	assert.ok(beforePointer?.scopes.includes('variable.other.reference.purebasic'));

	// the multiplication sign is an operator, never a pointer or a reference
	const multiply = lines[4]!.filter((t) => t.text === '*' || t.text === '@');
	assert.equal(multiply.length, 1, 'the `*` of `a * b` tokenizes');
	assert.ok(
		multiply[0]!.scopes.includes('keyword.operator.symbol.purebasic'),
		`a multiplication is an operator, got ${multiply[0]!.scopes.join(' ') || 'no scope'}`,
	);
});

/*
 * Read off the PureBasic IDE's own preferences (`~/.purebasic/purebasic.prefs`,
 * the Monokai scheme) and measured from a screenshot of it: a *declaration* is
 * normal text -- a structure's name, a field, a native type suffix -- while a
 * *use* in code wears the colour the IDE gives identifiers and commands.  These
 * tests keep the two apart, because a theme can only colour them differently if
 * the grammar scopes them differently.
 */
test('a member read is code, a member declaration is not', { skip }, async () => {
	const lines = await tokenize(
		[
			'Structure IMAGE_THUNK_DATA',
			'\tStructureUnion',
			'\t\tFunction.i',
			'\t\tOrdinal.i',
			'\tEndStructureUnion',
			'\tList Items.Inner()',
			'\t*Entry',
			'EndStructure',
			'test\\Function',
			'test\\Entry',
		].join('\n'),
	);

	// a declaration no rule claims is left unscoped, and the tokenizer merges it
	// with the whitespace before it, so look for a token that contains the text
	const innermost = (line: number, text: string) => {
		const token = lines[line]!.find((t) => t.text.includes(text));
		assert.ok(token, `line ${line + 1}: ${text} did not tokenize`);
		return token.scopes[token.scopes.length - 1] ?? '';
	};

	// reading a member is code: the IDE colours it like an identifier
	assert.equal(innermost(8, '\\Function'), 'variable.other.member.purebasic');
	assert.equal(innermost(9, '\\Entry'), 'variable.other.member.purebasic');

	// declaring one is not: a field line is left as normal text, so a theme can
	// keep it plain the way the IDE does
	for (const [line, text] of [[2, 'Function'], [3, 'Ordinal'], [5, 'Items']] as const) {
		assert.equal(innermost(line, text), '', `line ${line + 1}: ${text} is a declaration`);
	}

	// a `*` field is a pointer, as it is anywhere else
	assert.equal(innermost(6, '*Entry'), 'variable.other.pointer.purebasic');

	// the block markers stay structure keywords, nested or not
	for (const [line, text] of [
		[0, 'Structure'],
		[1, 'StructureUnion'],
		[4, 'EndStructureUnion'],
		[7, 'EndStructure'],
	] as const) {
		assert.ok(
			innermost(line, text).startsWith('keyword.other.structure'),
			`line ${line + 1}: ${text} should stay a structure keyword`,
		);
	}
});

test('a type use is scoped apart from its declaration', { skip }, async () => {
	const lines = await tokenize(
		[
			'Structure Point',
			'\tx.i',
			'EndStructure',
			'pt.Point',
			'*Buffer.ScreenBuffer',
			'n.d = 1',
			'globalVar.i',
			'Procedure P()',
			'\tlocalVar.i',
			'EndProcedure',
		].join('\n'),
	);

	const innermost = (line: number, text: string) => {
		const token = lines[line]!.find((t) => t.text.trim() === text);
		assert.ok(token, `line ${line + 1}: ${text} did not tokenize`);
		return token.scopes[token.scopes.length - 1] ?? '';
	};

	// the declaration is a type name; the use is code, like the IDE
	assert.equal(innermost(0, 'Point'), 'entity.name.type.purebasic');
	assert.equal(innermost(3, 'Point'), 'entity.name.type.reference.purebasic');
	assert.equal(innermost(4, 'ScreenBuffer'), 'entity.name.type.reference.purebasic');
	// a native suffix is neither: it is a storage type
	assert.equal(innermost(5, 'd'), 'storage.type.purebasic');
	assert.equal(innermost(6, 'i'), 'storage.type.purebasic');

	// a plain name is code too, which is what the IDE colours it as
	assert.equal(innermost(5, 'n'), 'variable.other.purebasic');
	assert.equal(innermost(8, 'localVar'), 'variable.other.purebasic');
});

test('a multiplication sign is not a pointer', { skip }, async () => {
	// the PB IDE's own highlighter test asserts these are symbols
	const lines = await tokenize(['a * b', 'a*b', '2*3', 'x = *Memory', '*Buffer.ScreenBuffer'].join('\n'));

	for (const line of [0, 1, 2]) {
		assert.ok(
			!lines[line]!.some((t) => t.scopes.includes('variable.other.pointer.purebasic')),
			`line ${line + 1} is a multiplication`,
		);
	}
	const pointer = lines[3]!.find((t) => t.text.includes('*Memory'));
	assert.ok(pointer?.scopes.includes('variable.other.pointer.purebasic'), 'a real pointer keeps its scope');
	const declared = lines[4]!.find((t) => t.text.includes('*Buffer'));
	assert.ok(declared?.scopes.includes('variable.other.pointer.purebasic'));
});

test('symbolic operators are scoped, the sigils are not', { skip }, async () => {
	// the PB IDE's Monokai scheme gives operators the keyword colour, which a
	// selector can only reach once they have a scope
	const lines = await tokenize(['x = a + b * 2', 'If a <= b And c <> d', '*p = 0', 'a % 2'].join('\n'));

	const operator = (line: number, text: string) => {
		const token = lines[line]!.find((t) => t.text === text);
		assert.ok(token, `line ${line + 1}: ${text} did not tokenize`);
		return token.scopes;
	};

	for (const text of ['=', '+', '*']) {
		assert.ok(
			operator(0, text).includes('keyword.operator.symbol.purebasic'),
			`${text} should be an operator`,
		);
	}
	assert.ok(operator(1, '<=').includes('keyword.operator.symbol.purebasic'));
	assert.ok(operator(1, '<>').includes('keyword.operator.symbol.purebasic'));
	assert.ok(operator(3, '%').includes('keyword.operator.symbol.purebasic'), 'modulo, not a binary literal');

	// a `*` glued to a name is still a pointer, not an operator
	const pointer = lines[2]!.find((t) => t.text === '*p');
	assert.ok(pointer?.scopes.includes('variable.other.pointer.purebasic'));
});
