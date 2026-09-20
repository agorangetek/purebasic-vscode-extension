#!/usr/bin/env node
/*
 * Generates syntaxes/purebasic.tmLanguage.json from the generated data.
 *
 * Syntax highlighting is a TextMate grammar, and its keyword and command lists
 * have to stay in step with src/data/pb-builtins.json -- so they are not typed
 * out by hand here either.  The grammar's structure is written in this file;
 * only the word lists are generated.
 *
 * Usage:
 *   node tools/gen-grammar.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const data = JSON.parse(readFileSync(join(root, 'src', 'data', 'pb-builtins.json'), 'utf8'));

/** A regex alternation of names, with the regex metacharacters escaped. */
function alternation(names) {
	return names
		.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
		.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|');
}

const slug = (text) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

/*
 * The scope vocabulary follows duty1g/vscode-purebasic (MIT): keyword.control
 * and keyword.other, keyword.other.preprocessor for directives, constant.* for
 * values, entity.name.label with its colon and punctuation.separator.statement
 * for `:`.  Its own type rule matches any single letter anywhere
 * (`\b([ilqbfwdsa])\b`), which colours `i = 0` as a type, so ours keeps the
 * suffix anchored after a dot; the sigil, member, structure and assembly rules
 * it does not have are ours.
 *
 * Two of its choices are deliberately NOT followed, because the PureBasic IDE
 * colours these things as it colours a type or a function:
 *
 *   - library commands and user calls are entity.name.function, not
 *     support.function: the IDE gives both its Functions colour, and in the
 *     Monokai themes VS Code ships, entity.name.function is that same green.
 *     It is also what makes `MessageRequester` and `MyUserProc` one colour.
 *   - a member access and the name it hangs off are entity.name.type.member,
 *     not variable.other.*: the IDE gives a member its Structures colour, which
 *     is the entity.name.* green, and `OBJ\Map()` then reads as one thing
 *     instead of a green name next to a grey one.
 *
 * The editor decides which editor.quickSuggestions entry applies to a keystroke
 * by deriving a "standard token type" from a token's INNERMOST scope name, with
 * /\b(comment|string|regex|regexp)\b/ (getStandardTokenType in the editor's
 * tokenMetadata).  Both strings and comments default to "off", so a *code* scope
 * containing one of those words as a whole word silently stops the suggestion
 * widget from opening while you type: PureBasic's String library is exactly that
 * trap -- a library command scoped support.function.string.purebasic was
 * classified as a string, so typing `str` never popped up the list.
 *
 * Keep code scopes free of those words.  The literal scopes emitted by the
 * #strings and #comments rules are the only ones allowed to match, and the loop
 * that builds KEYWORD_SCOPES rejects a category whose scope would break this.
 * The grammar test does the rest: it tokenizes every command and keyword in the
 * data file and fails if any of them reads as a string or a comment.
 */
const RESERVED_TOKEN_TYPE = /\b(comment|string|regex|regexp)\b/;
const codeScope = (name) => (RESERVED_TOKEN_TYPE.test(name) ? `${name}lib` : name);

/** Keyword categories, in the order the grammar lists them. */
const KEYWORD_SCOPES = {
	'Control Flow': 'keyword.control',
	Procedures: 'keyword.control',
	Declarations: 'keyword.other',
	Structures: 'keyword.control',
	Modules: 'keyword.control',
	Macros: 'keyword.other.preprocessor',
	Data: 'keyword.control',
	Includes: 'keyword.other.preprocessor',
	Enumerations: 'keyword.control',
	Containers: 'keyword.other',
	Compiler: 'keyword.other.preprocessor',
	Operators: 'keyword.operator',
};

const keywordsByCategory = new Map();
for (const item of data.items) {
	if (item.kind !== 'keyword') continue;
	const scope = KEYWORD_SCOPES[item.category];
	if (!scope) continue;
	if (!keywordsByCategory.has(scope)) keywordsByCategory.set(scope, []);
	keywordsByCategory.get(scope).push(item.name);
}

// Hard-coded scopes: a collision here is a bug in this file, not in the data.
for (const [category, scope] of Object.entries(KEYWORD_SCOPES)) {
	if (RESERVED_TOKEN_TYPE.test(scope)) {
		throw new Error(
			`keyword scope '${scope}' (${category}) would classify code as a string or comment token`,
		);
	}
}

const commandsByLibrary = new Map();
for (const item of data.items) {
	if (item.kind === 'keyword') continue;
	const library = codeScope(slug(item.library ?? item.category ?? 'library'));
	if (!commandsByLibrary.has(library)) commandsByLibrary.set(library, []);
	commandsByLibrary.get(library).push(item.name);
}

export const grammar = {
	$schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
	name: 'PureBasic',
	scopeName: 'source.purebasic',
	fileTypes: ['pb', 'pbi', 'pbf'],
	patterns: [
		{ include: '#asm' },
		{ include: '#comments' },
		{ include: '#strings' },
		{ include: '#numbers' },
		{ include: '#structures' },
		{ include: '#declarations' },
		{ include: '#builtins' },
		{ include: '#members' },
		{ include: '#declared-calls' },
		{ include: '#labels' },
		{ include: '#specials' },
		{ include: '#statements' },
		{ include: '#operators' },
		{ include: '#constants' },
		{ include: '#keywords' },
		{ include: '#type-suffix' },
		// last, so it only catches what nothing else claimed: a plain identifier,
		// which the IDE colours like the code it sits in rather than as text
		{ include: '#identifiers' },
	],
	repository: {
		asm: {
			comment: 'A line starting with ! is inline assembly, not PureBasic.',
			name: 'meta.embedded.asm.purebasic',
			match: '^\\s*!.*$',
		},
		comments: {
			comment: 'PureBasic has exactly one comment, and no block form.',
			name: 'comment.line.semicolon.purebasic',
			match: ';.*$',
		},
		strings: {
			patterns: [
				{
					name: 'string.quoted.double.escape.purebasic',
					begin: '~"',
					end: '"',
					patterns: [{ name: 'constant.character.escape.purebasic', match: '\\\\.' }],
				},
				{
					name: 'string.quoted.double.purebasic',
					begin: '"',
					end: '"',
				},
			],
		},
		numbers: {
			patterns: [
				{
					// duty1g's rule is `\\b\\$...`, which can never match: `\\b`
					// needs a word character before the `$`.  A lookbehind does
					// the job.
					name: 'constant.numeric.hex.purebasic',
					match: '(?i)(?<![A-Za-z0-9_])\\$[0-9a-f]+\\b',
				},
				{ name: 'constant.numeric.bin.purebasic', match: '(?<![A-Za-z0-9_])%[01]+\\b' },
				{
					name: 'constant.numeric.float.purebasic',
					match: '(?<![A-Za-z0-9_])\\d+\\.\\d*(?:e[+-]?\\d+)?(?![A-Za-z0-9_])',
				},
				{
					name: 'constant.numeric.decimal.purebasic',
					match: '(?<![A-Za-z0-9_])\\d+(?:e[+-]?\\d+)?(?![A-Za-z0-9_])',
				},
			],
		},
		/*
		 * The body of a Structure, Interface or StructureUnion is a block, not a
		 * flat match, because a field name means nothing outside it: `x.i` inside
		 * a structure declares a member, while the same line in a procedure
		 * declares a local.  Only with the block open can a field be scoped like
		 * the `\x` that reads it -- the PureBasic IDE colours the two alike, and
		 * this is how a VS Code theme can.
		 */
		structures: {
			begin:
				'(?i)\\b(StructureUnion|Structure|Interface)\\b(?:\\s*\\.\\s*([A-Za-z_]\\w*))?\\s*([A-Za-z_]\\w*)?',
			beginCaptures: {
				1: { name: 'keyword.control.purebasic' },
				2: { name: 'storage.type.purebasic' },
				3: { name: 'entity.name.type.purebasic' },
			},
			end: '(?i)\\b(EndStructureUnion|EndStructure|EndInterface)\\b',
			endCaptures: { 0: { name: 'keyword.control.purebasic' } },
			patterns: [
				// a nested StructureUnion must open its own block before the
				// field rule can mistake it for a member
				{ include: '#structures' },
				{ include: '#field' },
				{ include: '#comments' },
				{ include: '#strings' },
				{ include: '#numbers' },
				{ include: '#keywords' },
				{ include: '#specials' },
				{ include: '#type-suffix' },
				{ include: '#members' },
				{ include: '#constants' },
				{ include: '#builtins' },
			],
		},
		declarations: {
			patterns: [
				{
					comment:
						'Procedure[.type] Name(...) and its Declare/Prototype forms.  The type is its own group: captured as part of the name it took the function colour and left the return type uncoloured.',
					match:
						'(?i)\\b(Procedure(?:DLL|C|CDLL)?|Declare(?:DLL|C|CDLL)?|PrototypeC?|Runtime\\s+Procedure)\\b(?:\\s*\\.\\s*([A-Za-z_]\\w*))?\\s+([A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.control.purebasic' },
						2: { name: 'storage.type.purebasic' },
						3: { name: 'entity.name.function.purebasic' },
					},
				},
				{
					comment:
						'Structure / Interface / Module / Enumeration declarations.  Enumeration[.type] with no name of its own is left to the keyword and type-suffix rules.',
					match:
						'(?i)\\b(DeclareModule|Module|EnumerationBinary|Enumeration)\\b(?:\\s*\\.\\s*([A-Za-z_]\\w*))?\\s+([A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.control.purebasic' },
						2: { name: 'storage.type.purebasic' },
						3: { name: 'entity.name.type.purebasic' },
					},
				},
				{
					match: '(?i)\\b(Macro)\\b(\\s+)([A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.other.preprocessor.purebasic' },
						3: { name: 'entity.name.function.purebasic' },
					},
				},
			],
		},
		builtins: {
			comment:
				'Every library command, one scope: the library name in the scope was a trap (support.function.string.* reads as a string token, which silences completion) and no theme needs the split.',
			patterns: [...commandsByLibrary.entries()].map(([, names]) => ({
				name: 'entity.name.function.purebasic',
				match: `(?i)\\b(?:${alternation(names)})\\b`,
			})),
		},
		members: {
			patterns: [
				{
					comment:
						'var\\field, Module::item, and the element form var\\map().  Scoped under entity.name.type so that a scheme paints it where it paints a type: the IDE gives a member its Structures colour, which in the Monokai themes VS Code ships is the entity.name.* green.',
					name: 'entity.name.type.member.purebasic',
					match: '(?:\\\\|::)[A-Za-z_]\\w*(?:\\(\\))?',
				},
				{
					name: 'entity.name.namespace.purebasic',
					match: '\\b[A-Za-z_]\\w*(?=::)',
				},
			],
		},
		'declared-calls': {
			comment: 'A name called with parentheses that is not a known command.',
			name: 'entity.name.function.purebasic',
			match: '\\b[A-Za-z_]\\w*(?=\\s*\\()',
		},
		labels: {
			name: 'entity.name.label.purebasic',
			match: '^\\s*[A-Za-z_]\\w*:',
		},
		statements: {
			// their punctuation scope: the `:` that separates statements
			name: 'punctuation.separator.statement.purebasic',
			match: ':',
		},
		specials: {
			patterns: [
				// `*p` is a pointer only when the `*` is glued to the name and not
				// glued to what comes before it: `a*b`, `2*3` and `a * b` are
				// multiplications, which the PB IDE colours as symbols.
				//
				// The scope is a `constant.*` one, not `variable.other.pointer`,
				// so that a scheme paints it where it paints a constant: in the
				// PureBasic IDE's own Monokai scheme PointerColor *is*
				// ConstantColor, and in VS Code's Monokai themes the purple family
				// is `constant.*`, so a pointer comes out purple beside `#MAX`.
				{ name: 'constant.other.pointer.purebasic', match: '(?<![A-Za-z0-9_])\\*[A-Za-z_]\\w*' },
				{ name: 'constant.other.reference.purebasic', match: '@[A-Za-z_]\\w*' },
				// a `@` with no name yet -- `@` on its own, or `@` before
				// something other than a name -- still wears the sigil's colour,
				// so a reference never looks half-coloured.  `@` has no other
				// meaning in PureBasic, which is why it is safe here (a bare `*`
				// is the multiplication operator and cannot be told apart).
				{ name: 'constant.other.reference.purebasic', match: '@(?![A-Za-z_])' },
				{ name: 'variable.other.label-reference.purebasic', match: '\\?[A-Za-z_]\\w*' },
			],
		},
		/*
		 * Symbolic operators.  The PureBasic IDE's Monokai scheme gives them the
		 * keyword colour (OperatorColor), and it cannot place them with a selector
		 * unless they are scoped.  This comes after the sigil rules, so the `*`
		 * of `*p` is still a pointer and only a lone `*` is an operator.
		 */
		identifiers: {
			comment:
				'A name that goes on to a type or a member -- `test.my_test`, `OBJ_MEMDLL\\ModulesMap()` -- is what a variable wears code colour for.  A name on its own is left unscoped, so the theme paints it its normal text, which is what the PureBasic IDE does.',
			name: 'entity.name.type.member.purebasic',
			match: '[A-Za-z_]\\w*(?=\\s*[.\\\\])',
		},
		operators: {
			// after #specials, so the `*` of `*p` is still a pointer
			match: '<<|>>|<=|>=|<>|[=+*/%&|<>^~-]',
			name: 'keyword.operator.purebasic',
		},
		constants: {
			patterns: [
				{ name: 'constant.language.boolean.purebasic', match: '(?i)\\b(True|False)\\b' },
				{ name: 'constant.language.null.purebasic', match: '(?i)\\b(#Null|Null)\\b' },
				{ name: 'constant.other.predefined.purebasic', match: '#\\w+' },
			],
		},
		keywords: {
			patterns: [...keywordsByCategory.entries()].map(([scope, names]) => ({
				name: `${scope}.purebasic`,
				match: `(?i)\\b(?:${alternation(names)})\\b`,
			})),
		},
		/*
		 * The .i / .TypeName after a name.  A native suffix is a storage type,
		 * like the PB IDE's own `type` colour; any other name is a type of its
		 * own, scoped like the name where it is declared so that `test.Point`
		 * and `Structure Point` agree whatever the theme.
		 */
		'type-suffix': {
			patterns: [
				{
					comment: 'The native single-letter suffixes, which pbcompiler reserves as structure names.',
					match: '(?<=\\b[A-Za-z_]\\w*)\\.([bawculifqds])(?![A-Za-z0-9_])',
					captures: { 1: { name: 'storage.type.purebasic' } },
				},
				{
					// a use of a type, not its declaration: `test.my_test`.  The
					// IDE colours this like the code around it (its Structure /
					// PureKeyword colour) while `Structure my_test` stays normal
					// text, so the two need scopes of their own.
					match: '(?<=\\b[A-Za-z_]\\w*)\\.([A-Za-z_]\\w*)',
					captures: { 1: { name: 'entity.name.type.reference.purebasic' } },
				},
			],
		},
	},
};

export const outFile = join(root, 'syntaxes', 'purebasic.tmLanguage.json');

/**
 * The one true text of the grammar file.  Both the writer and --check use it,
 * so the two can never disagree about what "generated" means.
 */
export const serialise = () => JSON.stringify(grammar, null, '\t') + '\n';

/*
 * Only act when run as a program.  Importing this module must have no effect,
 * or a staleness check built on the import could never fail.
 */
const runDirectly =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runDirectly) {
	const check = process.argv.includes('--check');
	const text = serialise();

	if (check) {
		// Fail loudly rather than write: this is what stops a grammar generated
		// from an older generator -- or not regenerated at all -- from shipping.
		// The generator once threw on an apostrophe in a comment and the stale
		// file was packaged anyway, so the extension shipped colours nobody
		// could see.  `npm run build` now runs this, and the test suite too.
		const onDisk = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
		if (onDisk !== text) {
			console.error(
				`stale: ${outFile} is not what this generator produces.\n` +
					'       run `npm run gen-grammar` and commit the result.',
			);
			process.exit(1);
		}
		console.log(`up to date: ${outFile}`);
	} else {
		writeFileSync(outFile, text);

		const builtinPatterns = grammar.repository.builtins.patterns.length;
		const keywordPatterns = grammar.repository.keywords.patterns.length;
		console.log(`wrote ${outFile}`);
		console.log(`  ${keywordPatterns} keyword groups:`, [...keywordsByCategory.keys()].join(', '));
		console.log(`  ${builtinPatterns} library groups:`, [...commandsByLibrary.keys()].join(', '));
	}
}
