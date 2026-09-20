/*
 * Keywords refreshed from the user's own KeywordsData.pbi.
 *
 * The point of these tests is that the refresh can only ever ADD: a new word is
 * offered and coloured, and nothing that was already there moves.  It rewrites
 * the grammar file the editor loads, so a merge that dropped a rule would take
 * the highlighting with it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addKeywordsToGrammar, keywordEntry, newKeywordNames, parseKeywordsData } from '../src/service/keywords.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const grammarPath = join(root, 'syntaxes', 'purebasic.tmLanguage.json');

/*
 * A cut-down copy of the IDE's own file, guards and all.  The real one is 195
 * lines of the same shape; this keeps the case under test legible.  Note the
 * two `CompilerIf #SpiderBasic` forms, which is the whole difficulty.
 */
const SAMPLE = [
	'; ---------------------------------------------------------------------------',
	';  Copyright (c) Fantaisie Software. All rights reserved.',
	'; ---------------------------------------------------------------------------',
	'',
	'; This file contains the definitions of all the PureBasic/SpiderBasic keywords.',
	'',
	'DataSection',
	'',
	'  ;- Keywords - BASIC',
	'',
	'  BasicKeywords:',
	'  Data$ "Align", "", " "',
	'  Data$ "And", "", " "',
	'  Data$ "Array", "", " "',
	'  Data$ "CallDebugger"     , "", ""',
	'  CompilerIf Not #SpiderBasic',
	'    Data$ "DeclareC"       , "", ""',
	'  CompilerEndIf',
	'  Data$ "DisableDebugger", "", ""',
	'  CompilerIf #SpiderBasic',
	'    Data$ "DisableJS"     , "", ""',
	'  CompilerEndIf',
	'  Data$ "List", "", " "',
	'',
	'  ;- Keywords - ASM',
	'  ASMKeywords:',
	'  Data$ "Mov", "", " "',
	'',
	'EndDataSection',
	'',
].join('\n');

test('the parser reads BasicKeywords and keeps the file order', () => {
	const names = parseKeywordsData(SAMPLE);
	assert.deepEqual(names, [
		'Align',
		'And',
		'Array',
		'CallDebugger',
		'DeclareC',
		'DisableDebugger',
		'List',
	]);
});

test('the SpiderBasic guards are honoured, since this is PureBasic', () => {
	const names = parseKeywordsData(SAMPLE);
	// `CompilerIf Not #SpiderBasic` is true for us
	assert.ok(names.includes('DeclareC'), 'a Not #SpiderBasic entry belongs to PureBasic');
	assert.ok(!names.includes('DisableJS'), 'a bare #SpiderBasic entry does not');
	// and the assembly section is not a keyword list here
	assert.ok(!names.includes('Mov'), 'ASM keywords come from elsewhere');
});

test('an unterminated or odd guard cannot leak a SpiderBasic word', () => {
	const unclosed = '  BasicKeywords:\n  CompilerIf #SpiderBasic\n    Data$ "EnableJS", "", ""\n';
	assert.deepEqual(parseKeywordsData(unclosed), []);
	// and the same word inside the Not guard is fine
	const notGuard =
		'  BasicKeywords:\n  CompilerIf Not #SpiderBasic\n    Data$ "EnableJS", "", ""\n  CompilerEndIf\n';
	assert.deepEqual(parseKeywordsData(notGuard), ['EnableJS']);
});

test('the parser ignores what cannot be a keyword', () => {
	const messy = [
		'  BasicKeywords:',
		'  Data$ "Real", "", " "',
		'  Data$ "With Space", "", " "',
		'  Data$ "", "", " "',
		'  Data$ "Real", "", " "',
		'  Data$ "9Leading", "", " "',
		'  ; Data$ "Commented", "", " "',
	].join('\n');
	assert.deepEqual(parseKeywordsData(messy), ['Real']);
});

test('only a word we do not already have counts as new', () => {
	const known = ['and', 'Align', 'LIST'];
	assert.deepEqual(newKeywordNames(known, ['And', 'Align', 'List', 'Array', 'CallDebugger']), [
		'Array',
		'CallDebugger',
	]);
	// case does not matter in either direction
	assert.deepEqual(newKeywordNames(['array'], ['ARRAY']), []);
});

test('the grammar merge appends to the keyword alternation and changes nothing else', () => {
	const before = readFileSync(grammarPath, 'utf8');
	const result = addKeywordsToGrammar(before, [
		'FutureKeyword',
		'AnotherFutureOne',
		'Not A Keyword',
	]);

	assert.deepEqual(result.added, ['FutureKeyword', 'AnotherFutureOne']);
	assert.notEqual(result.text, before);

	const after = JSON.parse(result.text) as {
		repository: Record<string, { patterns: { name?: string; match?: string }[] }>;
	};
	const scope = after.repository['keywords']!.patterns.find((p) => p.name === 'keyword.other.purebasic')!;
	const words = /^(?:.*\(\?:)(.*)(?:\).*)$/.exec(scope.match!)![1]!.split('|');
	for (const name of ['FutureKeyword', 'AnotherFutureOne']) {
		assert.ok(words.includes(name), `${name} should be one of the ${words.length} alternatives`);
	}
	// and the alternation is still a well-formed `(?i)\b(?:...)\b`
	assert.match(scope.match!, /^\(\?i\)\\b\(\?:/);
	assert.match(scope.match!, /\)\\b$/);

	// every other part of the grammar survives untouched: same rules, and the
	// only difference anywhere is the one keyword pattern
	const original = JSON.parse(before) as typeof after;
	assert.equal(
		after.repository['keywords']!.patterns.length,
		original.repository['keywords']!.patterns.length,
		'no keyword group was added or dropped',
	);
	for (const key of Object.keys(original.repository)) {
		const a = JSON.stringify(original.repository[key]);
		const b = JSON.stringify(after.repository[key]);
		if (key === 'keywords') {
			assert.notEqual(a, b, 'the keywords group is the one that changed');
			continue;
		}
		assert.equal(a, b, `the ${key} rules must be untouched`);
	}
	assert.deepEqual(Object.keys(after), Object.keys(original), 'the top level is untouched');
});

test('merging is idempotent, and a merge with nothing new writes nothing', () => {
	const before = readFileSync(grammarPath, 'utf8');
	const once = addKeywordsToGrammar(before, ['FutureKeyword', 'AnotherFutureOne']);
	const twice = addKeywordsToGrammar(once.text, ['FutureKeyword', 'AnotherFutureOne']);
	assert.deepEqual(twice.added, []);
	assert.equal(twice.text, once.text, 'a second pass must be a no-op, not a duplicate');
});

test('a word the grammar already knows in another keyword group is not re-added', () => {
	// Procedure and EndProcedure are keyword.control, List and Array are
	// keyword.other, CallDebugger is keyword.control: none of them is new, and
	// none of them may end up in a second alternation
	const before = readFileSync(grammarPath, 'utf8');
	const result = addKeywordsToGrammar(before, [
		'Procedure',
		'EndProcedure',
		'List',
		'Array',
		'CallDebugger',
		'ForEach',
		'XOr',
	]);
	assert.deepEqual(result.added, []);
	assert.equal(result.text, before, 'the file must be untouched');
});

test('a grammar that cannot be parsed is left alone rather than replaced', () => {
	const broken = '{ not json';
	const result = addKeywordsToGrammar(broken, ['Array']);
	assert.equal(result.text, broken);
	assert.deepEqual(result.added, []);
});

test('a refreshed keyword is a completion entry with a canonical spelling', () => {
	const entry = keywordEntry('SomeNewThing');
	assert.equal(entry.name, 'SomeNewThing');
	assert.equal(entry.lower, 'somenewthing');
	assert.equal(entry.kind, 'keyword');
	assert.equal(entry.id, 'somenewthing|keyword');
});
