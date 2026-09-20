import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PB_BUILTINS } from '../src/data/pb-builtins.ts';
import {
	allBlocks,
	allBuiltins,
	builtinCount,
	builtinMarkdown,
	builtinSource,
	isCompletableName,
	lookupBuiltin,
} from '../src/service/builtins.ts';

test('the generated data covers the language', () => {
	assert.ok(builtinCount() > 1500, `expected >1500 entries, got ${builtinCount()}`);
	assert.match(builtinSource(), /PureBasic/);

	const names = new Set(allBuiltins().map((i) => i.name.toLowerCase()));
	for (const expected of [
		'messagerequester',
		'addelement',
		'openfile',
		'procedurereturn',
		'endprocedure',
		'redim',
		'foreach',
		'structure',
		'proceduredll',
	]) {
		assert.ok(names.has(expected), `the data is missing "${expected}"`);
	}
});

test('keywords carry the manual spelling, not the lower-case key', () => {
	const canonical = PB_BUILTINS.keywordCanonical;
	assert.equal(canonical['endprocedure'], 'EndProcedure');
	assert.equal(canonical['proceduredll'], 'ProcedureDLL');
	assert.equal(canonical['procedurecdll'], 'ProcedureCDLL');
	assert.equal(canonical['redim'], 'ReDim');
	assert.equal(canonical['foreach'], 'ForEach');
	assert.equal(canonical['compilerendif'], 'CompilerEndIf');
	assert.equal(canonical['xincludefile'], 'XIncludeFile');
	assert.equal(canonical['enableasm'], 'EnableASM');
	assert.equal(canonical['macroexpandedcount'], 'MacroExpandedCount');
	// every canonical form is the same letters, re-cased
	for (const [lower, name] of Object.entries(canonical)) {
		assert.equal(name.toLowerCase(), lower, `${lower} -> ${name}`);
	}
});

test('commands are looked up case-insensitively and carry signatures', () => {
	const message = lookupBuiltin('messagerequester');
	assert.ok(message);
	assert.equal(message.name, 'MessageRequester');
	assert.equal(message.kind, 'function');
	assert.ok(message.library, 'a command knows which library it belongs to');
	assert.deepEqual(
		message.signatures?.[0]?.params.map((p) => p.name),
		['Title$', 'Text$', 'Flags', 'ParentID'],
	);
	// the manual's optional groups are marked as such
	assert.deepEqual(
		message.signatures?.[0]?.params.map((p) => p.mode),
		['', '', 'optional', 'optional'],
	);

	const open = lookupBuiltin('OPENFILE');
	assert.equal(open?.name, 'OpenFile');
	assert.deepEqual(
		open?.signatures?.[0]?.params.map((p) => p.name),
		['#File', 'Filename$', 'Flags'],
	);

	const markdown = builtinMarkdown(message);
	assert.match(markdown, /^```purebasic\nResult = MessageRequester\(Title\$, Text\$/);
	assert.match(markdown, /requester/);
});

test('a command that returns a value is a function, a bare statement is a sub', () => {
	assert.equal(lookupBuiltin('abs')?.kind, 'function');
	assert.equal(lookupBuiltin('messagerequester')?.kind, 'function');
	assert.equal(lookupBuiltin('abortftpfile')?.kind, 'sub');
});

test('every item has a unique id and a name, and every command its own entry', () => {
	const ids = new Set<string>();
	for (const item of allBuiltins()) {
		assert.ok(item.name.length > 0, 'item without a name');
		assert.ok(item.id.length > 0, `${item.name} has no id`);
		assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
		ids.add(item.id);
	}
	// a name that is both a keyword and a command keeps the command's signature
	const add = lookupBuiltin('addelement');
	assert.equal(add?.kind, 'function');
	assert.ok(add?.signatures?.[0]?.label.startsWith('AddElement('));
});

test('blocks pair openers with their canonical terminators', () => {
	const byOpener = new Map(allBlocks().map((b) => [b.opener, b]));
	for (const opener of [
		'Procedure',
		'ProcedureDLL',
		'ProcedureC',
		'ProcedureCDLL',
		'Structure',
		'StructureUnion',
		'Interface',
		'Module',
		'DeclareModule',
		'Enumeration',
		'EnumerationBinary',
		'Macro',
		'DataSection',
		'Import',
		'ImportC',
		'CompilerIf',
		'CompilerSelect',
		'HeaderSection',
		'With',
		'If',
		'Select',
		'For',
		'ForEach',
		'While',
		'Repeat',
	]) {
		assert.ok(byOpener.has(opener), `${opener} is missing from the block table`);
	}
	assert.deepEqual(byOpener.get('Repeat')?.closers, ['Until', 'Forever']);
	assert.deepEqual(byOpener.get('Procedure')?.closers, ['EndProcedure']);
	assert.deepEqual(byOpener.get('If')?.closers, ['EndIf']);
	// every terminator is a real keyword
	const keywords = new Set(PB_BUILTINS.keywords);
	for (const block of allBlocks()) {
		assert.ok(keywords.has(block.opener), `${block.opener} is not a keyword`);
		for (const closer of block.closers) {
			assert.ok(keywords.has(closer), `${closer} is not a keyword`);
		}
	}
});

test('names that cannot be typed are kept out of completion', () => {
	assert.equal(isCompletableName('MessageRequester'), true);
	assert.equal(isCompletableName('Debug Expression'), false);
	assert.equal(isCompletableName(''), false);
});
