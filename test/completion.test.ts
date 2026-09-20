import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompletions, enclosingProcedure, fileNameOf } from '../src/service/completion.ts';
import { getHover } from '../src/service/hover.ts';
import { groupSymbols } from '../src/service/includes.ts';
import { parseDocument } from '../src/service/parser.ts';
import { getSignatureHelp } from '../src/service/signature.ts';

const MODULE = [
	'Structure Point',
	'\tx.i',
	'\ty.i',
	'EndStructure',
	'',
	'Procedure.d Add(a.d, b.d)',
	'\tProtected result.d',
	'\tresult = a + b',
	'\tProcedureReturn result',
	'EndProcedure',
	'',
	'#MAX = 10',
].join('\n');

const OPTIONS = { keywords: true, builtins: true, snippets: true };

function completeAt(source: string, line: number, character: number, word = '') {
	const document = parseDocument('file:///m.pb', source);
	return {
		document,
		items: buildCompletions({
			document,
			position: { line, character },
			word,
			options: OPTIONS,
		}),
	};
}

test('enclosingProcedure finds the procedure containing a line', () => {
	const doc = parseDocument('file:///m.pb', MODULE);
	assert.equal(enclosingProcedure(doc, { line: 8, character: 2 })?.name, 'Add');
	assert.equal(enclosingProcedure(doc, { line: 0, character: 0 }), undefined);
	assert.equal(enclosingProcedure(doc, { line: 11, character: 0 }), undefined);
});

test('completion offers locals, module symbols, commands and keywords', () => {
	const { items } = completeAt(MODULE, 7, 2);
	const labels = new Set(items.map((i) => i.label));

	assert.ok(labels.has('result'), 'local variable should be completed');
	assert.ok(labels.has('a'), 'procedure parameter should be completed');
	assert.ok(labels.has('Add'), 'module-level procedure should be completed');
	assert.ok(labels.has('Point'), 'structure should be completed');
	assert.ok(labels.has('#MAX'), 'constant should be completed');
	assert.ok(labels.has('MessageRequester'), 'library command should be completed');
	assert.ok(labels.has('Procedure'), 'keyword should be completed');

	// locals sort before module symbols, which sort before commands
	const rank = (label: string) => items.find((i) => i.label === label)!.sortText;
	assert.ok(rank('result') < rank('Add'), 'locals should sort first');
	assert.ok(rank('Add') < rank('MessageRequester'), 'document symbols before commands');
});

test('a command with parameters is offered as a call snippet', () => {
	const { items } = completeAt(MODULE, 7, 2, 'Message');
	const message = items.find((i) => i.label === 'MessageRequester');
	assert.ok(message, 'expected MessageRequester');
	assert.equal(message.isSnippet, true);
	assert.equal(message.insertText, 'MessageRequester(${1:Title}, ${2:Text}, ${3:Flags}, ${4:ParentID})');
});

test('block openers expand into a skeleton, closed by their terminator', () => {
	const { items } = completeAt('Procedure p()\n\t\nEndProcedure', 1, 1);
	for (const [opener, closer] of [
		['Procedure', 'EndProcedure'],
		['If', 'EndIf'],
		['Select', 'EndSelect'],
		['ForEach', 'Next'],
		['Repeat', 'Until'],
		['Structure', 'EndStructure'],
		['CompilerIf', 'CompilerEndIf'],
	]) {
		const item = items.find((i) => i.label === opener);
		assert.ok(item, `${opener} is offered at the start of a statement`);
		assert.equal(item.isSnippet, true, `${opener} expands into a block`);
		assert.ok(item.insertText.includes(closer), `${opener} inserts ${closer}`);
	}

	// the terminators and branch heads are offered too
	const labels = new Set(items.map((i) => i.label));
	for (const word of ['EndProcedure', 'EndIf', 'Case', 'Default', 'ElseIf', 'Continue']) {
		assert.ok(labels.has(word), `${word} is offered`);
	}
});

test('type suffixes are offered after a dot', () => {
	const source = ['Structure Point', '\tx.i', 'EndStructure', 'Procedure p()', '\tpt.', 'EndProcedure'].join(
		'\n',
	);
	const { items } = completeAt(source, 4, 4);
	const labels = new Set(items.map((i) => i.label));
	for (const suffix of ['i', 'd', 's', 'q']) {
		assert.ok(labels.has(suffix), `.${suffix} should be offered`);
	}
	assert.ok(labels.has('Point'), 'a structure is a type too');
	const integer = items.find((i) => i.label === 'i');
	assert.match(integer?.detail ?? '', /Integer/);
});

test('only items that start with the typed text are offered', () => {
	const doc = parseDocument('file:///m.pb', MODULE);
	const labelsFor = (word: string) =>
		new Set(
			buildCompletions({
				document: doc,
				position: { line: 7, character: 2 },
				word,
				options: OPTIONS,
			}).map((i) => i.label),
		);

	assert.ok(labelsFor('Mess').has('MessageRequester'), 'a matching prefix is offered');
	assert.ok(!labelsFor('Mess').has('Add'), 'anything else is not');
	assert.ok(labelsFor('mess').has('MessageRequester'), 'matching is case-insensitive');
	assert.ok(labelsFor('PROC').has('Procedure'));
	// with nothing typed, nothing is filtered
	assert.ok(labelsFor('').has('Add'));
});

test('hover documents commands and the user symbols', () => {
	const doc = parseDocument('file:///m.pb', MODULE);
	const command = getHover(doc, { line: 7, character: 3 });
	assert.ok(command, 'hovering inside a command name should return something');

	const source = ['MessageRequester("t", "m")', 'Procedure p()', 'EndProcedure'].join('\n');
	const doc2 = parseDocument('file:///h.pb', source);
	const onCommand = getHover(doc2, { line: 0, character: 4 });
	assert.ok(onCommand);
	assert.match(onCommand.contents, /MessageRequester/);

	const onUser = getHover(parseDocument('file:///m.pb', MODULE), { line: 11, character: 2 });
	assert.ok(onUser);
	assert.match(onUser.contents, /#MAX/);
});

test('signature help resolves built-ins and user procedures', () => {
	const source = [MODULE, '', 'MessageRequester("t", ', 'Add(1, '].join('\n');
	const doc = parseDocument('file:///s.pb', source);
	const offset = MODULE.split('\n').length;

	const builtin = getSignatureHelp(doc, { line: offset + 1, character: source.split('\n')[offset + 1]!.length });
	assert.ok(builtin, 'expected signature help inside a command call');
	assert.match(builtin.label, /^MessageRequester\(/);
	assert.equal(builtin.parameters.length, 4);
	assert.equal(builtin.activeParameter, 1);

	const user = getSignatureHelp(doc, { line: offset + 2, character: source.split('\n')[offset + 2]!.length });
	assert.ok(user, 'expected signature help inside a user procedure call');
	assert.match(user.label, /^Add\(/);
	assert.equal(user.activeParameter, 1);
	assert.equal(user.parameters.length, 2);
});

test('nothing is offered until enough of the name has been typed', () => {
	const doc = parseDocument('file:///m.pb', MODULE);
	const count = (word: string, minChars: number) =>
		buildCompletions({
			document: doc,
			position: { line: 7, character: 2 },
			word,
			options: { ...OPTIONS, minChars },
		}).length;

	assert.equal(count('', 3), 0, 'nothing typed, nothing offered');
	assert.equal(count('Me', 3), 0, 'two characters is too few');
	assert.ok(count('Mes', 3) > 0, 'three characters offers the list');
	assert.ok(count('M', 0) > 0, 'minChars 0 offers the list as soon as you type');
	assert.ok(count('Me', 2) > 0, 'the minimum is whatever it is set to');

	// a member list after a dot is asked for by the dot itself, so it is never
	// held back
	const memberDoc = parseDocument(
		'file:///p.pb',
		['Structure Point', '\tx.i', 'EndStructure', 'Procedure p()', '\tpt.', 'EndProcedure'].join('\n'),
	);
	const members = buildCompletions({
		document: memberDoc,
		position: { line: 4, character: 4 },
		word: '',
		options: { ...OPTIONS, minChars: 3 },
	});
	assert.ok(members.length > 0, 'the type list after a dot is offered straight away');
});

test('fileNameOf reads the file name out of a uri', () => {
	assert.equal(fileNameOf('file:///ws/lib/helpers.pb'), 'helpers.pb');
	assert.equal(fileNameOf('file:///ws/helpers.pb#L3'), 'helpers.pb');
	assert.equal(fileNameOf('/ws/lib/helpers.pb'), 'helpers.pb');
	assert.equal(fileNameOf('c:\\ws\\helpers.pb'), 'helpers.pb');
	assert.equal(fileNameOf('helpers.pb'), 'helpers.pb');
});

test('a symbol from another file says which file, one from this file does not', () => {
	const doc = parseDocument('file:///ws/main.pb', ['Add(1, 2)'].join('\n'));
	const workspaceSymbols = [
		{
			name: 'Helper',
			kind: 'procedure' as const,
			scope: '',
			file: 'file:///ws/lib/helpers.pb',
			line: 0,
			detail: 'Procedure Helper(x.i)',
			params: 'x.i',
		},
		{
			name: 'Shared',
			kind: 'variable' as const,
			scope: '',
			file: 'file:///ws/other.pb',
			line: 2,
			detail: 'Shared.i = 0',
		},
		{
			name: 'Add',
			kind: 'procedure' as const,
			scope: '',
			file: 'file:///ws/main.pb',
			line: 0,
			detail: 'Procedure Add(a.d, b.d)',
		},
	];

	const items = buildCompletions({
		document: doc,
		workspaceSymbols,
		position: { line: 0, character: 0 },
		word: '',
		options: OPTIONS,
	});
	const byLabel = new Map(items.map((i) => [i.label, i]));

	assert.equal(byLabel.get('Helper')?.labelDescription, 'helpers.pb', 'the popup names the file');
	assert.equal(byLabel.get('Shared')?.labelDescription, 'other.pb');
	assert.match(byLabel.get('Helper')?.documentation ?? '', /From `helpers\.pb`/);
	// a symbol of the document being completed in is not "from another file"
	assert.equal(byLabel.get('Add')?.labelDescription, undefined);
	assert.doesNotMatch(byLabel.get('Add')?.documentation ?? '', /From `/);

	// the file name is the sort key, so one file's symbols stay together
	assert.match(byLabel.get('Helper')?.sortText ?? '', /^2helpers\.pb/);
	assert.match(byLabel.get('Shared')?.sortText ?? '', /^2other\.pb/);
});

test('a structure from another file gives its fields after a backslash', () => {
	const source = ['Define p.Shape', '\tp\\', 'EndProcedure'].join('\n');
	const document = parseDocument('file:///ws/main.pb', source);
	const shapes = parseDocument(
		'file:///ws/lib/shapes.pbi',
		['Structure Shape', '\twidth.i', '\theight.i', 'EndStructure'].join('\n'),
	);

	const items = buildCompletions({
		document,
		workspaceSymbols: groupSymbols([shapes.uri], { uris: () => [shapes.uri], get: () => shapes }),
		position: { line: 1, character: 3 },
		word: '',
		options: OPTIONS,
	});
	const labels = items.map((i) => i.label);

	assert.deepEqual(labels, ['width', 'height'], 'the members of the other file structure');
	assert.match(items[0]!.documentation ?? '', /member of Shape/);

	// and the field is never offered as an ordinary name, only after the `\`
	const plain = buildCompletions({
		document,
		workspaceSymbols: groupSymbols([shapes.uri], { uris: () => [shapes.uri], get: () => shapes }),
		position: { line: 0, character: 0 },
		word: 'widt',
		options: OPTIONS,
	});
	assert.deepEqual(plain.map((i) => i.label), [], 'a field is not a name you can type anywhere');
});

test('members are the fields of the structure the variable is declared as', () => {
	const source = [
		'Structure Point',
		'\tx.i',
		'\ty.i',
		'EndStructure',
		'Structure Shape',
		'\twidth.i',
		'\theight.i',
		'EndStructure',
		'',
		'pt.Point',
		'\tpt\\',
	].join('\n');
	const document = parseDocument('file:///m.pb', source);

	const at = (word = '') =>
		buildCompletions({
			document,
			position: { line: 10, character: 4 },
			word,
			options: OPTIONS,
		}).map((i) => i.label);

	assert.deepEqual(at(), ['x', 'y'], 'only the fields of Point');
	assert.match(
		buildCompletions({
			document,
			position: { line: 10, character: 4 },
			word: '',
			options: OPTIONS,
		})[0]!.documentation ?? '',
		/member of Point/,
	);

	// a structure offered after a dot names the file it comes from
	const other = parseDocument('file:///ws/shapes.pbi', 'Structure Cube\n\tside.i\nEndStructure');
	const dotted = buildCompletions({
		document: parseDocument('file:///ws/use.pb', 'floor.Cu'),
		workspaceSymbols: other.symbols,
		position: { line: 0, character: 8 },
		word: 'Cu',
		options: OPTIONS,
	});
	assert.equal(dotted[0]?.label, 'Cube');
	assert.equal(dotted[0]?.labelDescription, 'shapes.pbi');

	// an unknown owner keeps every field rather than showing nothing
	const loose = parseDocument('file:///m2.pb', source.replace('pt.Point', 'mystery.Point'));
	const looseItems = buildCompletions({
		document: loose,
		position: { line: 10, character: 4 },
		word: '',
		options: OPTIONS,
	}).map((i) => i.label);
	assert.deepEqual(looseItems, ['x', 'y', 'width', 'height'], 'no owner, every field');
});

test('members follow a chain of structures, through a List, a Map and a pointer', () => {
	const source = [
		'Structure Inner',
		'\tvalue.i',
		'EndStructure',
		'Structure Other',
		'\tflag.i',
		'EndStructure',
		'Structure Outer',
		'\tList Items.Inner()',
		'\tMap Lookup.Inner()',
		'\t*Raw',
		'EndStructure',
		'o.Outer',
		'\to\\Items()\\',
		'\to\\Lookup("k")\\',
		'\to\\Raw\\',
		'\to\\Items()\\value\\',
		'\tmystery\\',
	].join('\n');
	const document = parseDocument('file:///chain.pb', source);
	const lines = source.split('\n');
	const at = (line: number) =>
		buildCompletions({
			document,
			position: { line, character: lines[line]!.length },
			word: '',
			options: OPTIONS,
		}).map((i) => i.label);

	assert.deepEqual(at(12), ['value'], 'a List element resolves to its element structure');
	assert.deepEqual(at(13), ['value'], 'and so does a Map element');
	assert.deepEqual(at(14), [], 'a bare pointer has no members to offer');
	assert.deepEqual(at(15), [], 'a native field has no members, so nothing is offered');
	assert.deepEqual(
		at(16),
		['value', 'flag', 'Items', 'Lookup', '*Raw'],
		'an undeclared name still leaves every known field on offer',
	);
});

test('a List, Map or Array member is inserted with its parentheses', () => {
	const source = [
		'Structure Inner',
		'\tv.i',
		'EndStructure',
		'Structure Outer',
		'\tList Items.Inner()',
		'\tMap Lookup.Inner()',
		'\tArray Slots.Inner(8)',
		'\tplain.i',
		'EndStructure',
		'o.Outer',
		'\to\\',
	].join('\n');
	const document = parseDocument('file:///c.pb', source);
	const items = buildCompletions({
		document,
		position: { line: 10, character: 3 },
		word: '',
		options: OPTIONS,
	});
	const inserted = new Map(items.map((i) => [i.label, i]));

	assert.equal(inserted.get('Items')?.insertText, 'Items()', 'a list has an empty form');
	assert.equal(inserted.get('Items')?.isSnippet, false);
	assert.equal(inserted.get('Lookup')?.insertText, 'Lookup(${1})', 'a map needs a key');
	assert.equal(inserted.get('Slots')?.insertText, 'Slots(${1})', 'an array needs an index');
	assert.equal(inserted.get('Lookup')?.isSnippet, true);
	assert.equal(inserted.get('plain')?.insertText, 'plain', 'a plain field stays plain');
	assert.equal(inserted.get('plain')?.isSnippet, false);
});
