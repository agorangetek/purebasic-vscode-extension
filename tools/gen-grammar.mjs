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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * The editor decides which editor.quickSuggestions entry applies to a keystroke
 * by deriving a "standard token type" from a token's INNERMOST scope name, with
 * /\b(comment|string|regex|regexp)\b/ (getStandardTokenType in the editor's
 * tokenMetadata).  Both strings and comments default to "off", so a *code* scope
 * containing one of those words as a whole word silently stops the suggestion
 * widget from opening while you type: PureBasic's String library is exactly that
 * trap -- `str` scoped as support.function.string.purebasic was classified as a
 * string, so typing it never popped up the list.
 *
 * Keep code scopes free of those words by gluing a suffix onto the offending
 * segment (`string` -> `stringlib`).  The literal scopes emitted by the #strings
 * and #comments rules are the only ones allowed to match.
 */
const RESERVED_TOKEN_TYPE = /\b(comment|string|regex|regexp)\b/;
const codeScope = (name) => (RESERVED_TOKEN_TYPE.test(name) ? `${name}lib` : name);

/** Keyword categories, in the order the grammar lists them. */
const KEYWORD_SCOPES = {
	'Control Flow': 'keyword.control',
	Procedures: 'keyword.other.procedure',
	Declarations: 'keyword.other.declaration',
	Structures: 'keyword.other.structure',
	Modules: 'keyword.other.module',
	Macros: 'keyword.other.macro',
	Data: 'keyword.other.data',
	Includes: 'keyword.other.include',
	Enumerations: 'keyword.other.enumeration',
	Containers: 'keyword.other.container',
	Compiler: 'keyword.other.compiler',
	Operators: 'keyword.operator.word',
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

const grammar = {
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
			name: 'constant.numeric.purebasic',
			// $ and % are not word characters, so the guard has to be a
			// lookbehind: \b before them would never match
			match:
				'(?i)(?<![A-Za-z0-9_])(?:\\$[0-9a-f]+|%[01]+|\\d+\\.\\d*(?:e[+-]?\\d+)?|\\d+(?:e[+-]?\\d+)?)(?![A-Za-z0-9_])',
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
				1: { name: 'keyword.other.structure.purebasic' },
				2: { name: 'storage.type.purebasic' },
				3: { name: 'entity.name.type.purebasic' },
			},
			end: '(?i)\\b(EndStructureUnion|EndStructure|EndInterface)\\b',
			endCaptures: { 0: { name: 'keyword.other.structure.purebasic' } },
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
						1: { name: 'keyword.other.procedure.purebasic' },
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
						1: { name: 'keyword.other.structure.purebasic' },
						2: { name: 'storage.type.purebasic' },
						3: { name: 'entity.name.type.purebasic' },
					},
				},
				{
					match: '(?i)\\b(Macro)\\b(\\s+)([A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.other.macro.purebasic' },
						3: { name: 'entity.name.function.purebasic' },
					},
				},
			],
		},
		builtins: {
			patterns: [...commandsByLibrary.entries()].map(([library, names]) => ({
				name: `support.function.${library}.purebasic`,
				match: `(?i)\\b(?:${alternation(names)})\\b`,
			})),
		},
		members: {
			patterns: [
				{
					comment: 'var\\field, and Module::item.',
					name: 'variable.other.member.purebasic',
					match: '(?:\\\\|::)[A-Za-z_]\\w*',
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
			match: '^\\s*([A-Za-z_]\\w*)(:)',
			captures: {
				1: { name: 'entity.name.label.purebasic' },
				2: { name: 'punctuation.separator.label.purebasic' },
			},
		},
		specials: {
			patterns: [
				// `*p` is a pointer only when the `*` is glued to the name and not
				// glued to what comes before it: `a*b`, `2*3` and `a * b` are
				// multiplications, which the PB IDE colours as symbols.
				{ name: 'variable.other.pointer.purebasic', match: '(?<![A-Za-z0-9_])\\*[A-Za-z_]\\w*' },
				{ name: 'variable.other.reference.purebasic', match: '@[A-Za-z_]\\w*' },
				// a `@` with no name yet -- `@` on its own, or `@` before
				// something other than a name -- still wears the sigil's colour,
				// so a reference never looks half-coloured.  `@` has no other
				// meaning in PureBasic, which is why it is safe here (a bare `*`
				// is the multiplication operator and cannot be told apart).
				{ name: 'variable.other.reference.purebasic', match: '@(?![A-Za-z_])' },
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
			name: 'variable.other.purebasic',
			match: '[A-Za-z_]\\w*',
		},
		operators: {
			match: '<<|>>|<=|>=|<>|[=+*/%&|<>^-]',
			name: 'keyword.operator.symbol.purebasic',
		},
		constants: {
			patterns: [
				{ name: 'support.constant.purebasic', match: '(?i)#PB_[A-Za-z0-9_]*' },
				{ name: 'constant.other.purebasic', match: '#[A-Za-z_][A-Za-z0-9_]*' },
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

const outFile = join(root, 'syntaxes', 'purebasic.tmLanguage.json');
writeFileSync(outFile, JSON.stringify(grammar, null, '\t') + '\n');

const builtinPatterns = grammar.repository.builtins.patterns.length;
const keywordPatterns = grammar.repository.keywords.patterns.length;
console.log(`wrote ${outFile}`);
console.log(`  ${keywordPatterns} keyword groups:`, [...keywordsByCategory.keys()].join(', '));
console.log(`  ${builtinPatterns} library groups:`, [...commandsByLibrary.keys()].join(', '));
