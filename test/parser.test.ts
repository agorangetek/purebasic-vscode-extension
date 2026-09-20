import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	callContextAt,
	inStringOrComment,
	maskSource,
	memberContextAt,
	parameterNames,
	parseDocument,
	statementContextAt,
	wordAt,
	wordBefore,
} from '../src/service/parser.ts';

const SAMPLE = [
	'; a module comment',
	'IncludeFile "shared.pbi"',
	'',
	'Structure Point',
	'\tx.i',
	'\ty.i',
	'\t*next.Point',
	'EndStructure',
	'',
	'Enumeration',
	'\t#Red',
	'\t#Green',
	'EndEnumeration',
	'',
	'#MAX = 10',
	'Global Dim scores.i(10)',
	'Global counter.i = 0',
	'',
	'Procedure.d Add(a.d, b.d)',
	'\tProtected result.d',
	'\tresult = a + b',
	'\tProcedureReturn result',
	'EndProcedure',
	'',
	'Declare Test(*p, name$)',
	'Module Helper',
	'\tProcedure Greet(who$)',
	'\t\tDebug who$',
	'\tEndProcedure',
	'EndModule',
	'',
	'finish:',
	'Data.i 1, 2, 3',
].join('\n');

test('maskSource blanks comments, strings and asm but keeps offsets', () => {
	const lines = SAMPLE.split('\n');
	const masked = maskSource(SAMPLE);
	assert.equal(masked.length, lines.length);
	for (let i = 0; i < lines.length; i++) {
		assert.equal(masked[i]!.length, lines[i]!.length, `line ${i} length changed`);
	}

	const extra = 'a = "text" ; note';
	const [only] = maskSource(extra);
	assert.ok(!only!.includes('text'), 'string contents should be blanked');
	assert.ok(!only!.includes('note'), 'the comment should be blanked');
	assert.ok(only!.startsWith('a = '), 'real code must survive masking');

	assert.ok(!maskSource('! mov eax, 1')[0]!.includes('mov'), 'asm lines are not PureBasic');
	assert.ok(
		!maskSource('s = ~"a\\"b"')[0]!.includes('b'),
		'the escape string ends after the escaped quote',
	);
});

test('parseDocument finds procedures, structures, enums, constants and includes', () => {
	const doc = parseDocument('file:///t.pb', SAMPLE);
	const byName = new Map(doc.symbols.map((s) => [s.name, s]));

	assert.equal(byName.get('Point')?.kind, 'structure');
	assert.equal(byName.get('x')?.kind, 'field');
	assert.equal(byName.get('x')?.scope, 'Point', 'fields belong to their structure');
	assert.equal(byName.get('*next')?.kind, 'field', 'the * is part of the name');

	assert.equal(byName.get('Red')?.kind, 'enummember');
	assert.equal(byName.get('#MAX')?.kind, 'constant');
	assert.equal(byName.get('scores')?.kind, 'array');
	assert.equal(byName.get('scores')?.type, 'i');
	assert.equal(byName.get('counter')?.kind, 'variable');

	assert.equal(byName.get('Add')?.kind, 'procedure');
	assert.equal(byName.get('Add')?.returns, 'd');
	assert.equal(byName.get('Add')?.params, 'a.d, b.d');
	assert.equal(byName.get('result')?.kind, 'variable');
	assert.equal(byName.get('result')?.scope, 'Add', 'locals belong to their procedure');

	assert.equal(byName.get('Test')?.kind, 'declare');
	assert.equal(byName.get('Helper')?.kind, 'module');
	assert.equal(byName.get('Greet')?.kind, 'procedure');

	assert.equal(byName.get('finish')?.kind, 'label');
	assert.deepEqual(doc.includes, ['shared.pbi']);
	assert.ok(!byName.has('Data'), 'a Data line is not a variable');
});

test('a procedure records the line its body ends on', () => {
	const doc = parseDocument('file:///t.pb', SAMPLE);
	assert.equal(doc.symbols.find((s) => s.name === 'Add')?.endLine, 22);
	assert.equal(doc.symbols.find((s) => s.name === 'Greet')?.endLine, 28);

	// a prototype has no body, so it has no closing line
	const prototype = parseDocument('file:///t.pb', 'Declare Foo(x.i)');
	assert.equal(prototype.symbols[0]?.kind, 'declare');
	assert.equal(prototype.symbols[0]?.endLine, undefined);
});

test('parameterNames reads sigils and types', () => {
	assert.deepEqual(parameterNames('*p, name$, x.d'), ['*p', 'name$', 'x']);
	assert.deepEqual(parameterNames('a.d'), ['a']);
	assert.deepEqual(parameterNames(''), []);
	assert.deepEqual(parameterNames(undefined), []);
});

test('wordAt returns the identifier under the cursor, sigil and suffix included', () => {
	const text = 'a = myVar$';
	const found = wordAt(text, { line: 0, character: 8 });
	assert.equal(found?.word, 'myVar$');
	assert.equal(found?.startChar, 4);
	assert.equal(found?.endChar, 10);
});

test('callContextAt reports the callee and the active parameter', () => {
	const text = 'MessageRequester("title", ';
	const context = callContextAt(text, { line: 0, character: text.length });
	assert.equal(context?.callee, 'MessageRequester');
	assert.equal(context?.activeParameter, 1);

	const nested = 'Foo(Bar(1, 2), ';
	const outer = callContextAt(nested, { line: 0, character: nested.length });
	assert.equal(outer?.callee, 'Foo');
	assert.equal(outer?.activeParameter, 1);
});

test('statementContextAt classifies the cursor position', () => {
	assert.equal(statementContextAt('  Pro', { line: 0, character: 5 }, 'Pro').kind, 'start');
	assert.equal(statementContextAt('  x = ', { line: 0, character: 6 }, '').kind, 'expression');
	assert.equal(statementContextAt('  a + ', { line: 0, character: 6 }, '').kind, 'expression');
	assert.equal(statementContextAt('  x = 1 : ', { line: 0, character: 10 }, '').kind, 'start');
	// a comment is not code
	assert.equal(statementContextAt('; Dim ', { line: 0, character: 6 }, '').kind, 'start');
});

test('wordBefore finds the word a typed character just finished', () => {
	assert.deepEqual(wordBefore('if ', 2), { word: 'if', start: 0, end: 2 });
	assert.deepEqual(wordBefore('  procedure ', 11), { word: 'procedure', start: 2, end: 11 });
	assert.deepEqual(wordBefore('name$ ', 5), { word: 'name$', start: 0, end: 5 });
	// nothing to the left: a space at the start of a line, or after punctuation
	assert.equal(wordBefore(' ', 0), undefined);
	assert.equal(wordBefore('x = ', 4), undefined);
	assert.equal(wordBefore('foo() ', 6), undefined);
});

test('a field may be named anything, including after a directive keyword', () => {
	// pbcompiler accepts these; a prefix match on Import/List/Map once dropped them
	const doc = parseDocument(
		'file:///p.pb',
		[
			'Structure Outer',
			'\tList Items.Inner()',
			'\tMap Lookup.Inner()',
			'\tArray Slots.Inner(8)',
			'\tImportedDllName$',
			'\tImportedDllHandle.i',
			'\tCompilerVersion.i',
			'\t*EntryPoint',
			'EndStructure',
		].join('\n'),
	);
	const fields = doc.symbols.filter((s) => s.kind === 'field').map((s) => s.name);

	assert.deepEqual(fields, [
		'Items',
		'Lookup',
		'Slots',
		'ImportedDllName$',
		'ImportedDllHandle',
		'CompilerVersion',
		'*EntryPoint',
	]);
});

test('the directives between fields are still not fields', () => {
	const doc = parseDocument(
		'file:///p.pb',
		[
			'Structure Outer',
			'\tExtends Base',
			'\tAlign 4',
			'\ta.i',
			'\tCompilerIf #PB_Compiler_64',
			'\tb.i',
			'\tCompilerEndIf',
			'EndStructure',
			'Import "user32.lib"',
			'EndImport',
		].join('\n'),
	);
	const fields = doc.symbols.filter((s) => s.kind === 'field').map((s) => s.name);
	assert.deepEqual(fields, ['a', 'b']);
});

test('a bare name.Type line declares the variable, as pbcompiler accepts', () => {
	const doc = parseDocument(
		'file:///p.pb',
		['Structure MyStruct', '\ta.i', 'EndStructure', '', 'x.MyStruct', '*p.MyStruct', 'y.i'].join('\n'),
	);
	const declared = doc.symbols
		.filter((s) => s.kind === 'variable')
		.map((s) => `${s.name}:${s.type ?? ''}${s.pointer ? ':pointer' : ''}`);

	assert.deepEqual(declared, ['x:MyStruct', '*p:MyStruct:pointer', 'y:i']);
});

test('a List, Map or Array field is recorded as a container', () => {
	const doc = parseDocument(
		'file:///p.pb',
		[
			'Structure Inner',
			'\tv.i',
			'EndStructure',
			'Structure Outer',
			'\tList Items.Inner()',
			'\tMap Lookup.Inner()',
			'\tArray Slots.Inner(8)',
			'\tplain.i',
			'EndStructure',
		].join('\n'),
	);
	const fields = doc.symbols
		.filter((s) => s.kind === 'field')
		.map((s) => `${s.name}:${s.container ?? '-'}:${s.type ?? '-'}`);

	assert.deepEqual(fields, [
		'v:-:i',
		'Items:list:Inner',
		'Lookup:map:Inner',
		'Slots:array:Inner',
		'plain:-:i',
	]);
});

/*
 * What may be offered depends on what is being typed: a type name only after
 * `name.`, a member only after something that can have one, and nothing at all
 * inside a string, a comment or after a dot that no type belongs after.
 */
test('the member context only claims a dot or a backslash that can take one', () => {
	const cases: [string, string, string][] = [
		['IncludeFile "memdll.', 'none', 'a dot inside a string'],
		['IncludeFile "memdll.pb"', 'plain', 'after the closing quote'],
		['m\\ImportedList().', 'none', 'a dot after a call'],
		['m\\ImportedList()\\ImportedDllHandle.', 'none', 'a dot after a member'],
		['x = 1.', 'none', 'a dot after a number'],
		['x = a[1].', 'none', 'a dot after an index'],
		['x.y.', 'none', 'a second type suffix'],
		['; note.', 'none', 'a dot inside a comment'],
		['pt.', 'type', 'a plain declaration'],
		['*p.', 'type', 'a pointer declaration'],
		['Procedure Foo(a.', 'type', 'a parameter'],
		['s = "a" + y.', 'type', 'an expression tail'],
		['n = 1\\', 'none', 'a backslash after a number'],
		['m\\', 'member', 'a member access'],
		['items(0)\\', 'member', 'a member after an index'],
		['\\', 'member', 'a bare backslash in a With block'],
		['s = ~"a\\"b.', 'none', 'a dot inside an escape string'],
		['s = ~"a\\"b"', 'plain', 'after the escape string closes'],
	];

	for (const [line, wanted, why] of cases) {
		assert.equal(
			memberContextAt(line, { line: 0, character: line.length }),
			wanted,
			`${why}: ${JSON.stringify(line)}`,
		);
	}
});

test('inStringOrComment knows where code stops being code', () => {
	assert.equal(inStringOrComment('IncludeFile "memdll.', { line: 0, character: 20 }), true);
	assert.equal(inStringOrComment('IncludeFile "memdll.pb"', { line: 0, character: 23 }), false);
	assert.equal(inStringOrComment('x = 1 ; note', { line: 0, character: 12 }), true);
	// a plain string takes no escapes, so this one is closed
	assert.equal(inStringOrComment('x = "a\\"', { line: 0, character: 8 }), false);
	// an escape string does
	assert.equal(inStringOrComment('x = ~"a\\"b', { line: 0, character: 10 }), true);
});
