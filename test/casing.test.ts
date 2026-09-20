/*
 * Tests for the canonical-casing rewrite behind the "Format Text" command.
 *
 * One rule: every keyword and library command is restored to the manual's
 * spelling, and the user's own identifiers are left exactly as written.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeIdentifiers } from '../src/service/casing.ts';
import { parseDocument } from '../src/service/parser.ts';

function format(source: string) {
	return canonicalizeIdentifiers(source, parseDocument('file:///x.pb', source).symbols);
}

test('keywords and commands are folded to the manual spelling', () => {
	const { text, changes } = format(
		[
			'procedure.d area(w.d, h.d)',
			'\tprocedurereturn w * h',
			'endprocedure',
			'messagerequester("hi", "there")',
			'redim a.i(10)',
			'foreach x()',
			'next',
		].join('\n'),
	);
	assert.equal(
		text,
		[
			'Procedure.d area(w.d, h.d)',
			'\tProcedureReturn w * h',
			'EndProcedure',
			'MessageRequester("hi", "there")',
			'ReDim a.i(10)',
			'ForEach x()',
			'Next',
		].join('\n'),
	);
	// Procedure, ProcedureReturn, EndProcedure, MessageRequester, ReDim, ForEach, Next
	assert.equal(changes, 7);
});

test('the user names are untouched, wherever they are written', () => {
	const source = [
		'Structure Point',
		'\tx.i',
		'\t*next.Point',
		'\tlabel$',
		'EndStructure',
		'Procedure MyProc(*pBuffer, name$)',
		'\tProtected myResult.d',
		'\tmyResult = *pBuffer',
		'EndProcedure',
		'#MyConst = 10',
	].join('\n');
	const { text } = format(source);

	for (const untouched of ['Point', '*next', 'label$', 'MyProc', '*pBuffer', 'name$', 'myResult', '#MyConst']) {
		assert.ok(text.includes(untouched), `${untouched} was rewritten:\n${text}`);
	}
	// ... while the language around them is folded down
	assert.ok(text.includes('Structure Point'), text);
	assert.ok(text.includes('EndStructure'), text);
	assert.ok(text.includes('Procedure MyProc(*pBuffer, name$)'), text);
	assert.ok(text.includes('\tProtected myResult.d'), text);
});

test('a local shadowing a command keeps the command out of the file', () => {
	// messagerequester is declared, so the formatter leaves the name alone
	// rather than guessing which spelling was meant
	const source = [
		'procedure messagerequester(a.i)',
		'\tprocedurereturn a',
		'endprocedure',
		'x = messagerequester(1)',
	].join('\n');
	const { text } = format(source);
	assert.ok(text.includes('Procedure messagerequester(a.i)'), text);
	assert.ok(text.includes('\tProcedureReturn a'), text);
	assert.ok(text.includes('x = messagerequester(1)'), text);
});

test('comments and string literals are left exactly as written', () => {
	const source = [
		'; redim and foreach written in a comment',
		'MessageRequester("endprocedure", "foreach")',
	].join('\n');
	const { text } = format(source);
	assert.ok(text.includes('; redim and foreach written in a comment'), text);
	assert.ok(text.includes('"endprocedure", "foreach"'), text);
	assert.ok(text.includes('MessageRequester("endprocedure", "foreach")'), text);
});

test('line endings and untouched text are preserved byte for byte', () => {
	const source = ['redim a.i(2)', '', '; \u00e9\u00e0\u00fc comment', 'a(0) = 1'].join('\r\n');
	const { text } = format(source);
	assert.equal(text, ['ReDim a.i(2)', '', '; \u00e9\u00e0\u00fc comment', 'a(0) = 1'].join('\r\n'));
});

test('formatting is idempotent', () => {
	const source = ['procedure p()', '\tforeach x()', '\tnext', 'endprocedure'].join('\n');
	const once = format(source);
	const twice = canonicalizeIdentifiers(
		once.text,
		parseDocument('file:///x.pb', once.text).symbols,
	);
	assert.equal(twice.changes, 0, twice.text);
	assert.equal(twice.text, once.text);
});

test('an empty document and a document with nothing to fix are unchanged', () => {
	assert.deepEqual(canonicalizeIdentifiers(''), { text: '', changes: 0 });
	const clean = 'Procedure p()\nEndProcedure';
	assert.deepEqual(canonicalizeIdentifiers(clean), { text: clean, changes: 0 });
});
