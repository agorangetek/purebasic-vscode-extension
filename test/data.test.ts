import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PB_BUILTINS } from '../src/data/pb-builtins.ts';
import {
	allBlocks,
	allBuiltins,
	builtinCount,
	builtinMarkdown,
	builtinSource,
	canonicalKeyword,
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

test('a reserved word has a canonical spelling, a library command does not', () => {
	assert.equal(canonicalKeyword('if'), 'If');
	assert.equal(canonicalKeyword('PROCEDURE'), 'Procedure');
	assert.equal(canonicalKeyword('redim'), 'ReDim');
	assert.equal(canonicalKeyword('foreach'), 'ForEach');

	// a command can also be a variable name, so it is not re-cased on a space
	for (const command of ['print', 'left', 'open', 'abs', 'MessageRequester']) {
		assert.equal(canonicalKeyword(command), undefined, `${command} is not a keyword`);
	}
	assert.equal(canonicalKeyword('x'), undefined);
	// and no false positive from the prototype chain
	assert.equal(canonicalKeyword('constructor'), undefined);
	assert.equal(canonicalKeyword('toString'), undefined);
});

/*
 * src/data/pb-builtins.json and src/data/pb-builtins.ts are two halves of one
 * generated dataset: the grammar is generated from the .json, and the extension
 * -- so completion, hover and canonical case -- imports the .ts.  Editing one
 * used to leave the other behind, and nothing noticed: nine reserved words
 * reached the syntax highlighter and never reached the completion list in
 * 0.1.22.  0.1.20's grammar guard could not see it, because the grammar was
 * right.  These tests pin the halves to each other from the side that matters --
 * what the extension actually offers.
 */
const dataFile = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'pb-builtins.json'),
		'utf8',
	),
) as {
	items: { id: string; name: string; lower: string; kind: string; category: string }[];
	keywords: string[];
	keywordCanonical: Record<string, string>;
	count: number;
};

test('the bundled data is not stale against the data file it is generated from', () => {
	const bundled = new Set(PB_BUILTINS.items.map((i) => i.id));
	const missing = dataFile.items.filter((i) => !bundled.has(i.id)).map((i) => i.name);
	assert.deepEqual(
		missing.slice(0, 20),
		[],
		`src/data/pb-builtins.ts is stale -- run npm run gen-builtins-ts (${missing.length} missing)`,
	);
	assert.equal(PB_BUILTINS.items.length, dataFile.items.length);
	assert.equal(PB_BUILTINS.count, dataFile.count);
});

test('every keyword the data file lists is offered, with its canonical spelling', () => {
	const bundled = new Set(PB_BUILTINS.keywords.map((k) => k.toLowerCase()));
	const missing = dataFile.keywords.filter((k) => !bundled.has(k.toLowerCase()));
	assert.deepEqual(
		missing,
		[],
		`the .ts is stale: ${missing.join(', ')} is in the .json and not in the bundled data`,
	);
	// and the ones the IDE's own table has, which the script table was missing
	for (const word of [
		'List',
		'Map',
		'Array',
		'As',
		'CallDebugger',
		'DebugLevel',
		'DisableDebugger',
		'EnableDebugger',
		'IncludePath',
	]) {
		assert.equal(canonicalKeyword(word), word, `${word} should be a keyword`);
	}
	// SpiderBasic's own keywords are not PureBasic's
	for (const word of ['DisableJS', 'EnableJS']) {
		assert.equal(canonicalKeyword(word), undefined, `${word} is SpiderBasic-only`);
	}
});
