/*
 * The colour audit for the PureBasic grammar.
 *
 *   node tools/theme-audit.mjs                       # the theme you run
 *   node tools/theme-audit.mjs <theme.json> ...      # any VS Code theme file
 *   node tools/theme-audit.mjs --palette docs/purebasic-ide-monokai.jsonc
 *
 * The extension ships no colours of its own -- a theme decides them -- so the
 * only way to know what a user sees is to ask a theme.  This does, for every
 * scope the grammar can emit.
 *
 * "Audit every scope" means: tokenize real PureBasic, read the INNERMOST scope
 * of every token, and ask the theme what colour it renders that scope.  Two
 * tokenizer passes are needed because neither one alone is enough --
 * tokenizeLine2 has the colour but merges runs, tokenizeLine has the scopes but
 * no colour -- so each non-binary token is attributed to the binary run that
 * CONTAINS its start offset.  That is exact; matching on token text is not.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const onig = require('vscode-oniguruma');
const vsctm = require('vscode-textmate');

const VSC = '/Applications/VSCodium.app/Contents/Resources/app/extensions';
const grammarPath = new URL('../syntaxes/purebasic.tmLanguage.json', import.meta.url).pathname;

await onig.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);

/* ------------------------------------------------------------------ corpus */
// One entry per line of real PureBasic, chosen so that every rule in the
// grammar fires at least once.  `! mov eax, 1` and friends are deliberately
// real code: an unclosed string here would swallow the rest of the corpus.
const CORPUS = [
	'Structure Point',
	'\tx.i',
	'\tList Items.Inner()',
	'\t*Entry',
	'\tStructureUnion',
	'\t\tFunction.i',
	'\tEndStructureUnion',
	'EndStructure',
	'StructureUnion',
	'EndStructureUnion',
	'Interface Foo',
	'\tDoIt()',
	'EndInterface',
	'Module Mod',
	'EndModule',
	'DeclareModule D',
	'EndDeclareModule',
	'Enumeration',
	'EndEnumeration',
	'EnumerationBinary',
	'EndEnumeration',
	'Macro M',
	'EndMacro',
	'DataSection',
	'Data.i 1, 2',
	'EndDataSection',
	'CompilerIf #PB_Compiler_OS = #PB_OS_MacOS',
	'CompilerElse',
	'CompilerEndIf',
	'IncludeFile "x.pbi"',
	'XIncludeFile "y.pbi"',
	'Import "z.lib"',
	'EndImport',
	'! mov eax, 1',
	'ProcedureDLL.i Area(w.d, h.d)',
	'EndProcedure',
	'Declare.i Bar(x.i)',
	'Prototype.i Pb(x.i)',
	'Runtime Procedure Rt()',
	'ProcedureReturn 1',
	'Debug "text"',
	'Debug ~"a \\" b\\n"',
	'x$ = "hi"',
	'; a comment',
	'x = 1 : y = 2',
	'#MAX = 100',
	'#PB_Event_CloseWindow',
	'n = $FF + %1010 + 12.5 + 1',
	'flag = #True',
	'nothing = #Null',
	'ok = True',
	'no = False',
	'void = Null',
	'If a = b And c <> d',
	'ElseIf a <= b',
	'Else',
	'EndIf',
	'x = a + b * 2 - 1 / 3 % 2',
	'y = a << 2 | b & c',
	'z = a ~ b',
	'Dim arr.i(2)',
	'ReDim arr.i(4)',
	'Global g.i',
	'Protected p.i',
	'Define d.Point',
	'Static s.i',
	'Threaded t.i',
	'ForEach lst()',
	'Next',
	'For i = 0 To 10 Step 2',
	'Next i',
	'While x',
	'Wend',
	'Repeat',
	'Until x',
	'Forever',
	'Select x',
	'Case 1',
	'Default',
	'EndSelect',
	'With obj',
	'EndWith',
	'*buffer = AllocateMemory(10)',
	'*pBuffer = 0',
	'p = @MyProc()',
	'p2 = @MyProc',
	'q = ?data',
	'data:',
	'top:',
	'pt.Point',
	'test\\age = 1',
	'test\\ImportedList()',
	'OBJ_MEMDLL\\ModulesMap()',
	'Mod::DoIt()',
	'Helper::DoIt()',
	'count = count + 1',
	'name.s',
	'count2.l',
	'ptr.POINT',
	'MessageRequester("t", "m")',
	'r = Abs(-1)',
	'MyUserProc(1)',
	'If FindMapElement(OBJ_MEMDLL\\ModulesMap(), Str(*module))',
	'Procedure Test()',
	'\tstr',
	'EndProcedure',
];

/* ------------------------------------------------------------ theme loading */
/**
 * Accepts whatever shape the colours come in: a VS Code theme file (tokenColors),
 * a vscode-textmate theme (settings), or the snippet this repo documents
 * (textMateRules).  The extension itself ships none of these -- these are the
 * user's theme, which is the whole point.
 */
function toRawTheme(json) {
	if (Array.isArray(json.textMateRules)) return { name: json.name, settings: json.textMateRules };
	if (Array.isArray(json.tokenColors)) return { name: json.name, settings: json.tokenColors };
	return json;
}

async function loadGrammarFor(themeJson) {
	const registry = new vsctm.Registry({
		onigLib: Promise.resolve({
			createOnigScanner: (p) => new onig.OnigScanner(p),
			createOnigString: (s) => new onig.OnigString(s),
		}),
		loadGrammar: async (s) =>
			s === 'source.purebasic'
				? vsctm.parseRawGrammar(readFileSync(grammarPath, 'utf8'), 'pb.json')
				: null,
	});
	registry.setTheme(toRawTheme(themeJson));
	const colorMap = registry.getColorMap();
	const grammar = await registry.loadGrammar('source.purebasic');
	const colourOf = (m) => (colorMap[(m >>> 15) & 0x1ff] ?? 'default').toUpperCase();
	return { grammar, colourOf };
}

/** scope -> Map(colour -> examples), plus every token, for one theme. */
async function resolveScopes(themeJson) {
	const { grammar, colourOf } = await loadGrammarFor(themeJson);
	const scopeColours = new Map();
	const tokens = [];
	const defaultTheme = await loadGrammarFor({ settings: [] });

	let binStack = vsctm.INITIAL;
	let txtStack = vsctm.INITIAL;
	let refStack = vsctm.INITIAL;
	for (const line of CORPUS) {
		const bin = grammar.tokenizeLine2(line, binStack);
		binStack = bin.ruleStack;
		const txt = grammar.tokenizeLine(line, txtStack);
		txtStack = txt.ruleStack;
		// What the theme would give an UNSCOPED token, so an unclaimed scope is
		// reported as the default rather than as "no colour".
		const ref = defaultTheme.grammar.tokenizeLine2(line, refStack);
		refStack = ref.ruleStack;

		const runs = [];
		for (let i = 0; i < bin.tokens.length; i += 2) {
			const start = bin.tokens[i];
			const end = i + 2 < bin.tokens.length ? bin.tokens[i + 2] : line.length;
			runs.push({ start, end, colour: colourOf(bin.tokens[i + 1]) });
		}
		const refRuns = [];
		for (let i = 0; i < ref.tokens.length; i += 2) {
			const start = ref.tokens[i];
			const end = i + 2 < ref.tokens.length ? ref.tokens[i + 2] : line.length;
			refRuns.push({ start, end, colour: defaultTheme.colourOf(ref.tokens[i + 1]) });
		}

		let r = 0;
		let rr = 0;
		for (const t of txt.tokens) {
			while (r + 1 < runs.length && runs[r].end <= t.startIndex) r++;
			while (rr + 1 < refRuns.length && refRuns[rr].end <= t.startIndex) rr++;
			const scope = t.scopes[t.scopes.length - 1] ?? 'source.purebasic';
			const text = line.slice(t.startIndex, t.endIndex);
			const colour = runs[r] && t.startIndex < runs[r].end ? runs[r].colour : '??';
			const unthemed = refRuns[rr] ? refRuns[rr].colour : '??';
			tokens.push({ line, text, colour, scope });
			if (!scopeColours.has(scope)) scopeColours.set(scope, new Map());
			const byColour = scopeColours.get(scope);
			if (!byColour.has(colour)) byColour.set(colour, { examples: [], unthemed });
			const entry = byColour.get(colour);
			if (entry.examples.length < 3 && text.trim()) entry.examples.push(text.trim());
		}
	}
	return { scopeColours, tokens };
}

/* ------------------------------------------------------- grammar inventory */
const grammarJson = JSON.parse(readFileSync(grammarPath, 'utf8'));
const inventory = new Map();
(function walk(o) {
	if (Array.isArray(o)) return o.forEach(walk);
	if (!o || typeof o !== 'object') return;
	if (typeof o.name === 'string' && o.name !== 'PureBasic' && o.name !== 'source.purebasic') {
		for (const part of o.name.split(' ')) {
			if (part.includes('.')) inventory.set(part, (inventory.get(part) ?? 0) + 1);
		}
	}
	for (const v of Object.values(o)) walk(v);
})(grammarJson);

/* ----------------------------------------------------------------- the CLI */
const args = process.argv.slice(2);

if (args[0] === '--palette') {
	/*
	 * The opt-in IDE palette is only worth documenting if it really reproduces
	 * the IDE, so check both halves of that claim: every selector must name a
	 * scope the grammar emits, and every scope must come out the colour the
	 * IDE's own Monokai scheme uses.
	 */
	const palettePath = args[1];
	const palette = JSON.parse(readFileSync(palettePath, 'utf8'));

	const IDE = {
		'keyword.control.purebasic': '#F92672',
		'keyword.other.purebasic': '#F92672',
		'keyword.other.preprocessor.purebasic': '#F92672',
		'keyword.operator.purebasic': '#F92672',
		'entity.name.function.purebasic': '#A6E22E',
		'string.quoted.double.purebasic': '#E6DB74',
		'string.quoted.double.escape.purebasic': '#E6DB74',
		'constant.character.escape.purebasic': '#E6DB74',
		'comment.line.semicolon.purebasic': '#75715E',
		'meta.embedded.asm.purebasic': '#66D9EF',
		'entity.name.label.purebasic': '#E69F66',
		'variable.other.label-reference.purebasic': '#E69F66',
		'constant.other.predefined.purebasic': '#AE81FF',
		'constant.language.boolean.purebasic': '#AE81FF',
		'constant.language.null.purebasic': '#AE81FF',
		'constant.numeric.decimal.purebasic': '#AE81FF',
		'constant.numeric.hex.purebasic': '#AE81FF',
		'constant.numeric.bin.purebasic': '#AE81FF',
		'constant.numeric.float.purebasic': '#AE81FF',
		'constant.other.pointer.purebasic': '#AE81FF',
		'constant.other.reference.purebasic': '#AE81FF',
		'entity.name.type.reference.purebasic': '#A6E22E',
		'entity.name.type.member.purebasic': '#A6E22E',
		'entity.name.namespace.purebasic': '#A6E22E',
		'entity.name.type.purebasic': '#F8F8F2',
		'storage.type.purebasic': '#F8F8F2',
		'punctuation.separator.statement.purebasic': '#F8F8F0',
		'source.purebasic': '#F8F8F2',
	};

	// 1. every selector in the palette must be a scope the grammar can emit
	const selectors = new Set();
	for (const rule of palette.textMateRules ?? []) {
		for (const s of [rule.scope ?? []].flat()) {
			selectors.add(s.replace(/^source\.purebasic\s+/, '').trim());
		}
	}
	let bad = 0;
	// A selector is a prefix match in TextMate: `comment` claims every
	// comment.* scope.  So the test is not equality -- it is that the selector
	// names a scope the grammar really emits, at some depth.
	const claims = (selector) =>
		selector === 'source.purebasic' ||
		[...inventory.keys()].some((scope) => scope === selector || scope.startsWith(`${selector}.`));
	for (const s of [...selectors].sort()) {
		if (!claims(s)) {
			console.log(`  selector matches no scope: ${s}`);
			bad++;
		}
	}
	console.log(`selectors: ${selectors.size} checked against ${inventory.size} scopes in the grammar`);

	// 2. every scope must render the colour the IDE uses
	const { scopeColours } = await resolveScopes(palette);
	for (const scope of Object.keys(IDE).sort()) {
		const want = IDE[scope];
		const byColour = scopeColours.get(scope);
		if (!byColour) {
			console.log(`  ??  ${scope.padEnd(44)} never tokenized`);
			bad++;
			continue;
		}
		const got = [...byColour.keys()];
		const ok = got.length === 1 && got[0] === want;
		if (!ok) bad++;
		console.log(`  ${ok ? 'ok ' : 'BAD'} ${scope.padEnd(44)} want ${want}  got ${got.join(' ')}`);
	}

	// 3. and no scope may be left unclaimed (it would inherit NormalText, which
	//    is right for names but wrong for anything the IDE colours)
	const unclaimed = [];
	for (const scope of [...inventory.keys()].sort()) {
		if (IDE[scope]) continue;
		unclaimed.push(scope);
	}
	if (unclaimed.length) console.log(`\n  scopes with no palette rule: ${unclaimed.join(', ')}`);

	console.log(bad ? `\n${bad} PROBLEM(S)` : '\nall selectors and colours check out');
	process.exit(bad ? 1 : 0);
}

const themePaths = args.length
	? args
	: [`${VSC}/theme-monokai/themes/monokai-color-theme.json`];

for (const themePath of themePaths) {
	const themeJson = JSON.parse(readFileSync(themePath, 'utf8'));
	const { scopeColours } = await resolveScopes(themeJson);
	console.log(`\n================ ${themePath.split('/').pop()} ================\n`);
	const unused = [];
	for (const scope of [...inventory.keys()].sort()) {
		const byColour = scopeColours.get(scope);
		if (!byColour) {
			unused.push(scope);
			console.log(`  ${scope.padEnd(44)} NOT EXERCISED by the corpus`);
			continue;
		}
		const parts = [...byColour.entries()].map(([colour, { examples, unthemed }]) => {
			const same = colour === unthemed ? ' =default' : '';
			return `${colour}${same}${examples.length ? ` (${[...new Set(examples)].join(', ')})` : ''}`;
		});
		const flag = byColour.size > 1 ? '   <-- varies by context' : '';
		console.log(`  ${scope.padEnd(44)} ${parts.join(' | ')}${flag}`);
	}
	if (unused.length) console.log(`\n  (${unused.length} inventory scope(s) never exercised)`);
}
