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

const commandsByLibrary = new Map();
for (const item of data.items) {
	if (item.kind === 'keyword') continue;
	const library = slug(item.library ?? item.category ?? 'library');
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
		{ include: '#declarations' },
		{ include: '#builtins' },
		{ include: '#members' },
		{ include: '#declared-calls' },
		{ include: '#labels' },
		{ include: '#specials' },
		{ include: '#constants' },
		{ include: '#keywords' },
		{ include: '#type-suffix' },
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
		declarations: {
			patterns: [
				{
					comment: 'Procedure[.type] Name(...) and its Declare/Prototype forms.',
					match:
						'(?i)\\b(Procedure(?:DLL|C|CDLL)?|Declare(?:DLL|C|CDLL)?|PrototypeC?|Runtime\\s+Procedure)\\b(\\s*\\.?)([A-Za-z_]\\w*)?',
					captures: {
						1: { name: 'keyword.other.procedure.purebasic' },
						2: { name: 'storage.type.purebasic' },
						3: { name: 'entity.name.function.purebasic' },
					},
				},
				{
					comment: 'Structure / Interface / Module / Enumeration declarations.',
					match:
						'(?i)\\b(StructureUnion|Structure|Interface|DeclareModule|Module|EnumerationBinary|Enumeration)\\b(\\s*\\.?)([A-Za-z_]\\w*)?(\\s+)([A-Za-z_]\\w*)',
					captures: {
						1: { name: 'keyword.other.structure.purebasic' },
						2: { name: 'storage.type.purebasic' },
						3: { name: 'storage.type.purebasic' },
						5: { name: 'entity.name.type.purebasic' },
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
				{ name: 'variable.other.pointer.purebasic', match: '\\*[A-Za-z_]\\w*' },
				{ name: 'variable.other.reference.purebasic', match: '@[A-Za-z_]\\w*' },
				{ name: 'variable.other.label-reference.purebasic', match: '\\?[A-Za-z_]\\w*' },
			],
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
		'type-suffix': {
			comment: 'The .i / .d / .TypeName that follows a name.',
			match: '(?<=\\b[A-Za-z_]\\w*)\\.([A-Za-z]\\w*)',
			captures: { 1: { name: 'storage.type.purebasic' } },
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
