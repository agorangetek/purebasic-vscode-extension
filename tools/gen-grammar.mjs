#!/usr/bin/env node
// Generates syntaxes/purebasic.tmLanguage.json from src/data/pb-builtins.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const data = JSON.parse(readFileSync(join(root, 'src', 'data', 'pb-builtins.json'), 'utf8'));

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

const RESERVED_TOKEN_TYPE = /\b(comment|string|regex|regexp)\b/;
const codeScope = (name) => (RESERVED_TOKEN_TYPE.test(name) ? `${name}lib` : name);

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

const BUILTIN_TYPE = '(?i:(?:[bawculifqds]|p-(?:ascii|unicode|bstr|variant|utf8)))(?![A-Za-z0-9_])';
const TYPE_NAME = '([A-Za-z_]\\w*)';

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

		{ include: '#identifiers' },
	],
	repository: {
		asm: {
			name: 'meta.embedded.asm.purebasic',
			match: '^\\s*!.*$',
		},
		comments: {
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

		structures: {
			begin:
				'(?i)\\b(StructureUnion|Structure|Interface)\\b(?:\\s*\\.\\s*(?:' +
				BUILTIN_TYPE +
				'|' +
				TYPE_NAME +
				'))?\\s*(?:[A-Za-z_]\\w*)?',
			beginCaptures: {
				1: { name: 'keyword.control.purebasic' },

				2: { name: 'entity.name.type.reference.purebasic' },

			},
			end: '(?i)\\b(EndStructureUnion|EndStructure|EndInterface)\\b',
			endCaptures: { 0: { name: 'keyword.control.purebasic' } },
			patterns: [

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
					match:
						'(?i)\\b(Procedure(?:DLL|C|CDLL)?|Declare(?:DLL|C|CDLL)?|PrototypeC?|Runtime\\s+Procedure)\\b(?:\\s*\\.\\s*(?:' +
						BUILTIN_TYPE +
						'|' +
						TYPE_NAME +
						'))?\\s+([A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.control.purebasic' },
						2: { name: 'entity.name.type.reference.purebasic' },
						3: { name: 'entity.name.function.purebasic' },
					},
				},
				{
					match:
						'(?i)\\b(DeclareModule|Module|EnumerationBinary|Enumeration)\\b(?:\\s*\\.\\s*(?:' +
						BUILTIN_TYPE +
						'|' +
						TYPE_NAME +
						'))?\\s+(?:[A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.control.purebasic' },
						2: { name: 'entity.name.type.reference.purebasic' },
					},
				},
				{
					match: '(?i)\\b(Macro)\\b\\s+[A-Za-z_]\\w*',
					captures: {
						1: { name: 'keyword.other.preprocessor.purebasic' },
					},
				},
			],
		},
		builtins: {
			patterns: [...commandsByLibrary.entries()].map(([, names]) => ({
				name: 'entity.name.function.purebasic',
				match: `(?i)\\b(?:${alternation(names)})\\b`,
			})),
		},
		members: {
			patterns: [
				{
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
			name: 'entity.name.function.purebasic',
			match: '\\b[A-Za-z_]\\w*(?=\\s*\\()',
		},
		labels: {
			name: 'entity.name.label.purebasic',
			match: '^\\s*[A-Za-z_]\\w*:',
		},
		statements: {
			name: 'punctuation.separator.statement.purebasic',
			match: ':',
		},
		specials: {
			patterns: [

				{ name: 'constant.other.pointer.purebasic', match: '(?<![A-Za-z0-9_])\\*[A-Za-z_]\\w*' },
				{ name: 'constant.other.reference.purebasic', match: '@[A-Za-z_]\\w*' },

				{ name: 'constant.other.reference.purebasic', match: '@(?![A-Za-z_])' },
				{ name: 'variable.other.label-reference.purebasic', match: '\\?[A-Za-z_]\\w*' },
			],
		},

		// A name in front of a BUILT-IN type is normal text, like the type
		// itself: matched so nothing else claims it, scoped as nothing.
		identifiers: {
			patterns: [
				{
					match: '[A-Za-z_]\\w*(?=\\s*\\.\\s*' + BUILTIN_TYPE + ')',
				},
				{
					name: 'entity.name.type.member.purebasic',
					match: '[A-Za-z_]\\w*(?=\\s*[.\\\\])',
				},
			],
		},
		operators: {
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

		// A built-in suffix is normal text, hence no scope here; anything
		// longer after the dot is a structure name.
		'type-suffix': {
			patterns: [
				{
					match: '(?<=\\b[A-Za-z_]\\w*)\\.' + BUILTIN_TYPE,
				},
				{
					match: '(?<=\\b[A-Za-z_]\\w*)\\.([A-Za-z_]\\w*)',
					captures: { 1: { name: 'entity.name.type.reference.purebasic' } },
				},
			],
		},
	},
};

export const outFile = join(root, 'syntaxes', 'purebasic.tmLanguage.json');

export const serialise = () => JSON.stringify(grammar, null, '\t') + '\n';

const runDirectly =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runDirectly) {
	const check = process.argv.includes('--check');
	const text = serialise();

	if (check) {
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
