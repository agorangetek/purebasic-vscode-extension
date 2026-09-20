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
import { spawnSync } from 'node:child_process';
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
	assertScoped(lines, '#PB_Event_CloseWindow', /^constant\.other\.predefined/, 'a predefined constant');
	assertScoped(lines, 'EndProcedure', /^keyword\./, 'a terminator');
	assertScoped(lines, 'ReDim', /^keyword\./, 'ReDim');
	assertScoped(lines, 'ForEach', /^keyword\.control/, 'ForEach');
});

test('library commands and user calls wear the function colour', { skip }, async () => {
	const lines = await tokenize(['MessageRequester("t", "m")', 'r = Abs(-1)', 'MyUserProc(1)'].join('\n'));

	// the PureBasic IDE gives a library command and a call of the reader's own
	// procedure the same green (Monokai's Functions colour), so one scope serves
	// both; splitting them only bought a distinction no scheme could show
	assertScoped(lines, 'MessageRequester', /^entity\.name\.function\.purebasic$/, 'a library command');
	assertScoped(lines, 'Abs', /^entity\.name\.function\.purebasic$/, 'a library command');
	assertScoped(lines, 'MyUserProc', /^entity\.name\.function\.purebasic$/, 'an unknown call');
});

/*
 * A declaration name is normal text to the IDE.  Its highlighter colours a word
 * by what SURROUNDS it -- a `(`, a `::`, a `.Type`, a `\` -- and never by being
 * declared, so `MemDll` in `Module MemDll` and `Point` in `Structure Point` are
 * plain, while the `MemDll` of `MemDll::DoIt()` and the `Point` of `pt.Point`
 * are not.  There is no declaration-name scope at all, so a theme cannot
 * colour one; that is the same choice the built-in type suffixes get.
 */
test('a declared name is left as normal text, the way the IDE draws it', { skip }, async () => {
	const lines = await tokenize(
		[
			'Procedure.d Area(w.d, h.d)',
			'Declare.i Bar(x.i)',
			'Prototype.i Callback(x.i)',
			'Structure Point',
			'Interface IFoo',
			'Enumeration Colour',
			'Macro M',
			'DeclareModule MemDll',
			'Module MemDll',
			'EndModule',
		].join('\n'),
	);

	const plain = (line: number, text: string) => {
		const token = lines[line]!.find((t) => t.text.trim() === text);
		assert.ok(token, `line ${line + 1}: "${text}" did not tokenize`);
		assert.equal(
			token.scopes.join(' '),
			'',
			`line ${line + 1}: "${text}" should be normal text, got ${token.scopes.join(' ')}`,
		);
	};

	// a name that nothing follows is a bare word
	for (const [line, name] of [
		[3, 'Point'],
		[4, 'IFoo'],
		[5, 'Colour'],
		[6, 'M'],
		[7, 'MemDll'],
		[8, 'MemDll'],
	] as const) {
		plain(line, name);
	}
	// the keyword in front of it is still a keyword
	for (const [line, keyword] of [
		[3, 'Structure'],
		[4, 'Interface'],
		[5, 'Enumeration'],
		[6, 'Macro'],
		[7, 'DeclareModule'],
		[8, 'Module'],
	] as const) {
		assert.ok(
			lines[line]!.some((t) => t.text.trim() === keyword && t.scopes.some((s) => s.startsWith('keyword'))),
			`line ${line + 1}: "${keyword}" should stay a keyword`,
		);
	}

	// a procedure's name IS followed by `(`, so it keeps the function colour
	assertScoped(lines, 'Area', /^entity\.name\.function/, 'a procedure name');
	assertScoped(lines, 'Bar', /^entity\.name\.function/, 'a declared name');
	assertScoped(lines, 'Callback', /^entity\.name\.function/, 'a prototype name');
});

test('members, sigils and labels are scoped', { skip }, async () => {
	const lines = await tokenize(
		['pt\\x = 1', 'Helper::DoIt()', '*pBuffer = AllocateMemory(4)', 'p = @MyProc()', 'd = ?data', 'top:', '! mov eax, 1'].join(
			'\n',
		),
	);
	assertScoped(lines, '\\x', /^entity\.name\.type\.member/, 'member access');
	assertScoped(lines, '*pBuffer', /^constant\.other\.pointer/, 'pointer variable');
	assertScoped(lines, '@MyProc', /^constant\.other\.reference/, 'procedure address');
	assertScoped(lines, '?data', /^variable\.other\.label-reference/, 'data label reference');
	assertScoped(lines, 'top:', /^entity\.name\.label/, 'a label, colon included');
	assertScoped(lines, '! mov eax, 1', /^meta\.embedded\.asm/, 'inline assembly');

	assertScoped(lines, 'Helper', /^entity\.name\.namespace/, 'a module qualifier');
	assertScoped(lines, '::DoIt()', /^entity\.name\.type\.member/, 'a module member');
});

/*
 * The PureBasic IDE has no type colour.  HighlightingEngine.pb upper-cases the
 * word after a `.` and asks whether it is ONE character of
 * #BasicTypeChars = "ABCUWLSFDQI" (a b c u w l s f d q i); if it is it paints it
 * *NormalTextColor, and it gives the name in front of the dot the same
 * treatment.  Anything longer is a structure name and gets *StructureColor.
 * So `test.i` is normal text end to end and `test.my_test` is code end to end:
 * the type suffix is deliberately left with NO scope, so each theme shows it as
 * the normal text it is rather than as some type colour of the extension's
 * invention.  There is no colour rule for this anywhere -- not in the grammar,
 * not in the package -- which is why these tests assert the ABSENCE of a scope.
 */
test('a built-in type is normal text, on both sides of the dot', { skip }, async () => {
	// every built-in type, in both cases, and the five `.p-*` string forms
	const builtins = 'i l s a b c w u f d q I L S A B C W U F D Q'.split(' ');
	const lines = await tokenize([
		...builtins.map((t) => `test.${t}`),
		'name.p-ascii',
		'name.p-utf8',
		'name.p-bstr',
		'name.p-variant',
		'name.p-unicode',
		'Procedure.d Area(w.d, h.d)',
		'Declare.i Test(x.i)',
		'Prototype.i Callback(x.i)',
		'Enumeration.i',
		'x.d = 1.5',
	].join('\n'));

	// A token merges with the whitespace around it, so compare on the trimmed
	// text; every token matching `text` on that line must carry no scope.
	const unscoped = (line: number, text: string) => {
		const tokens = lines[line]!.filter((t) => t.text.trim() === text);
		if (line === 0) {
			assert.ok(tokens.length > 0, `line ${line + 1}: "${text}" did not tokenize`);
		}
		for (const token of tokens) {
			assert.equal(
				token.scopes.join(' '),
				'',
				`line ${line + 1}: "${text}" must be plain normal text, got ${token.scopes.join(' ')}`,
			);
		}
	};

	builtins.forEach((t, line) => {
		unscoped(line, 'test');
		unscoped(line, `.${t}`);
	});
	for (const [offset, form] of ['p-ascii', 'p-utf8', 'p-bstr', 'p-variant', 'p-unicode'].entries()) {
		const line = builtins.length + offset;
		unscoped(line, 'name');
		unscoped(line, `.${form}`);
	}
	// a return type of a built-in type is normal text too, never the function colour
	const firstReturn = builtins.length + 5;
	for (const line of [0, 1, 2, 3].map((n) => firstReturn + n)) {
		unscoped(line, '.d');
		unscoped(line, '.i');
	}
	// and the fractional part of a number is still a number, not a type
	assertScoped(lines, '1.5', /^constant\.numeric/, 'a decimal literal');
});

test('a structure type is code, on both sides of the dot', { skip }, async () => {
	const lines = await tokenize(
		['test.my_test', 'pt.Point', 'Procedure.MyStruct Make()', 'Structure Point', '\tx.i'].join('\n'),
	);

	// a `.` followed by anything that is not a built-in type is a structure use,
	// and the name in front of it is part of the same expression
	for (const [line, text] of [
		[0, 'test'],
		[0, 'my_test'],
		[1, 'pt'],
		[1, 'Point'],
		[2, 'MyStruct'],
	] as const) {
		const token = lines[line]!.find((t) => t.text.trim() === text);
		assert.ok(token, `line ${line + 1}: "${text}" did not tokenize`);
		assert.ok(
			token.scopes.some((s) => s.startsWith('entity.name.type')),
			`line ${line + 1}: "${text}" is a structure, got ${token.scopes.join(' ') || 'no scope'}`,
		);
	}

	// the procedure name after a structure return type is still a function
	assertScoped(lines, 'Make', /^entity\.name\.function/, 'a procedure name');

	// the declaration itself stays normal text, and so does a field with a
	// built-in type -- the IDE does not colour a field either
	const point = lines[3]!.find((t) => t.text.trim() === 'Point');
	assert.equal(point?.scopes.join(' '), '', 'Structure Point declares a name, it does not use one');
	for (const text of ['x', '.i']) {
		const token = lines[4]!.find((t) => t.text.trim() === text);
		assert.ok(token, `line 5: "${text}" did not tokenize`);
		assert.equal(token.scopes.join(' '), '', `line 5: "${text}" should be plain`);
	}
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
			token.scopes.includes('entity.name.function.purebasic'),
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
		assert.ok(token.scopes.includes('constant.other.reference.purebasic'), 'and to the scope');
	}

	// a sigil on its own is not left uncoloured
	const bare = lines[2]!.find((t) => t.text === '@');
	assert.ok(bare, 'the bare @ should tokenize');
	assert.ok(
		bare.scopes.includes('constant.other.reference.purebasic'),
		`a bare @ should be scoped, got ${bare.scopes.join(' ') || 'no scope'}`,
	);
	const beforePointer = lines[3]!.find((t) => t.text === '@');
	assert.ok(beforePointer?.scopes.includes('constant.other.reference.purebasic'));

	// the multiplication sign is an operator, never a pointer or a reference
	const multiply = lines[4]!.filter((t) => t.text === '*' || t.text === '@');
	assert.equal(multiply.length, 1, 'the `*` of `a * b` tokenizes');
	assert.ok(
		multiply[0]!.scopes.includes('keyword.operator.purebasic'),
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
	assert.equal(innermost(8, '\\Function'), 'entity.name.type.member.purebasic');
	assert.equal(innermost(9, '\\Entry'), 'entity.name.type.member.purebasic');

	// declaring one is not: a field line is left as normal text, so a theme can
	// keep it plain the way the IDE does
	for (const [line, text] of [[2, 'Function'], [3, 'Ordinal'], [5, 'Items']] as const) {
		assert.equal(innermost(line, text), '', `line ${line + 1}: ${text} is a declaration`);
	}

	// a `*` field is a pointer, as it is anywhere else
	assert.equal(innermost(6, '*Entry'), 'constant.other.pointer.purebasic');

	// the block markers stay structure keywords, nested or not
	for (const [line, text] of [
		[0, 'Structure'],
		[1, 'StructureUnion'],
		[4, 'EndStructureUnion'],
		[7, 'EndStructure'],
	] as const) {
		assert.ok(
			innermost(line, text).startsWith('keyword.control'),
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

	// the DECLARATION is normal text (the IDE colours a bare word as normal
	// text); a USE of a structure type is code
	assert.equal(innermost(0, 'Point'), '');
	assert.equal(innermost(3, 'Point'), 'entity.name.type.reference.purebasic');
	assert.equal(innermost(4, 'ScreenBuffer'), 'entity.name.type.reference.purebasic');

	// a built-in type is neither, and the name in front of it is not to blame:
	// both sides are plain normal text, which is how the IDE draws `n.d`
	// the suffix is one token, dot included, now that no capture splits it off
	for (const [line, text] of [
		[5, '.d'],
		[5, 'n'],
		[6, '.i'],
		[6, 'globalVar'],
		[8, '.i'],
		[8, 'localVar'],
	] as const) {
		assert.equal(innermost(line, text), '', `line ${line + 1}: ${text} should be plain`);
	}
});

test('a multiplication sign is not a pointer', { skip }, async () => {
	// the PB IDE's own highlighter test asserts these are symbols
	const lines = await tokenize(['a * b', 'a*b', '2*3', 'x = *Memory', '*Buffer.ScreenBuffer'].join('\n'));

	for (const line of [0, 1, 2]) {
		assert.ok(
			!lines[line]!.some((t) => t.scopes.includes('constant.other.pointer.purebasic')),
			`line ${line + 1} is a multiplication`,
		);
	}
	const pointer = lines[3]!.find((t) => t.text.includes('*Memory'));
	assert.ok(pointer?.scopes.includes('constant.other.pointer.purebasic'), 'a real pointer keeps its scope');
	const declared = lines[4]!.find((t) => t.text.includes('*Buffer'));
	assert.ok(declared?.scopes.includes('constant.other.pointer.purebasic'));
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
			operator(0, text).includes('keyword.operator.purebasic'),
			`${text} should be an operator`,
		);
	}
	assert.ok(operator(1, '<=').includes('keyword.operator.purebasic'));
	assert.ok(operator(1, '<>').includes('keyword.operator.purebasic'));
	assert.ok(operator(3, '%').includes('keyword.operator.purebasic'), 'modulo, not a binary literal');

	// a `*` glued to a name is still a pointer, not an operator
	const pointer = lines[2]!.find((t) => t.text === '*p');
	assert.ok(pointer?.scopes.includes('constant.other.pointer.purebasic'));
});

test('a name is left to the theme unless it is taking a structure', { skip }, async () => {
	const lines = await tokenize(
		[
			'Define p.Point',
			'p\\x = 1',
			'p2.Point',
			'test.my_test',
			'count = count + 1',
			'name.s',
		].join('\n'),
	);

	const innermost = (line: number, text: string) => {
		const token = lines[line]!.find((t) => t.text.includes(text));
		assert.ok(token, `line ${line + 1}: ${text} did not tokenize`);
		return token.scopes[token.scopes.length - 1] ?? '';
	};

	// a name with a STRUCTURE after the dot is the one that turns
	for (const [line, text] of [[0, 'p'], [2, 'p2'], [3, 'test']] as const) {
		assert.equal(innermost(line, text), 'entity.name.type.member.purebasic', `line ${line + 1}: ${text}`);
	}
	// a member read is the member scope, and the name it comes off takes the code
	// colour with it: `p\x` is one expression
	assert.equal(innermost(1, 'x'), 'entity.name.type.member.purebasic');
	assert.equal(innermost(1, 'p'), 'entity.name.type.member.purebasic');
	// a name on its own is left to the theme, and so is one whose dot is followed
	// by a built-in type: the IDE paints both with its normal text
	assert.equal(innermost(4, 'count'), '', 'a name on its own is left to the theme');
	assert.equal(innermost(5, 'name'), '', 'a built-in type leaves its name plain');
});

test('a member access is one piece of code, element form included', { skip }, async () => {
	const source = 'If FindMapElement(OBJ_MEMDLL\\ModulesMap(), Str(*module))';
	const lines = await tokenize(source);

	const scopesOf = (text: string) => {
		const token = lines[0]!.find((t) => t.text === text);
		assert.ok(token, `${text} did not tokenize`);
		return token.scopes[token.scopes.length - 1] ?? '';
	};

	// the owner, the member and the empty element access all wear one scope, so
	// they can be one colour: `obj\map()` comes from a structure
	assert.equal(scopesOf('OBJ_MEMDLL'), 'entity.name.type.member.purebasic');
	assert.equal(scopesOf('\\ModulesMap()'), 'entity.name.type.member.purebasic');
	// and the code around it keeps its own scopes
	assert.ok(scopesOf('If').startsWith('keyword.control'));
	assert.equal(scopesOf('FindMapElement'), 'entity.name.function.purebasic');
	assert.equal(scopesOf('Str'), 'entity.name.function.purebasic');
	assert.equal(scopesOf('*module'), 'constant.other.pointer.purebasic');
});

/*
 * Regression guard.  syntaxes/purebasic.tmLanguage.json is generated, and it is
 * the file the editor actually loads: a generator that throws, or that has been
 * changed without regenerating, leaves the extension shipping the OLD grammar.
 * That happened -- a stray apostrophe inside a string literal made
 * tools/gen-grammar.mjs fail to parse, the failure was swallowed, and 0.1.19 was
 * packaged with scopes that made every colour fix invisible to the user.  The
 * tests above could not catch it either, because they tokenize whichever file is
 * on disk, stale or not.  This one compares the file against the generator.
 */
test('the committed grammar is what the generator produces', () => {
	const result = spawnSync(process.execPath, [join(root, 'tools', 'gen-grammar.mjs'), '--check'], {
		encoding: 'utf8',
	});
	assert.equal(
		result.status,
		0,
		`syntaxes/purebasic.tmLanguage.json is stale -- run \`npm run gen-grammar\`\n` +
			`${result.stdout ?? ''}${result.stderr ?? ''}`,
	);
});
