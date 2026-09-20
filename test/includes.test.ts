/*
 * The include graph decides which files may offer symbols to which.  PureBasic
 * only sees another file's procedures when an IncludeFile/XIncludeFile chain
 * reaches it, so these tests pin the resolution rules the compiler uses -- a
 * target is relative to the file that writes it, an IncludePath is relative to
 * the file that declares it (both verified against pbcompiler 6.41) -- and the
 * shape of the resulting group.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	dirOfPath,
	groupSymbols,
	includeGroup,
	pathOfUri,
	resolveIncludeTargets,
	uriForPath,
} from '../src/service/includes.ts';
import { parseDocument } from '../src/service/parser.ts';
import type { PbDocument } from '../src/service/types.ts';

/** A pool over a plain map of path -> source, the way the index feeds it. */
function poolOf(files: Record<string, string>) {
	const documents = new Map<string, PbDocument>();
	for (const [path, text] of Object.entries(files)) {
		documents.set(`file://${path}`, parseDocument(`file://${path}`, text));
	}
	return {
		uris: () => [...documents.keys()],
		get: (uri: string) => documents.get(uri),
	};
}

test('pathOfUri gives the decoded path a uri points at', () => {
	assert.equal(pathOfUri('file:///ws/lib/helpers.pb'), '/ws/lib/helpers.pb');
	assert.equal(pathOfUri('file:///ws/my%20files/a.pb'), '/ws/my files/a.pb');
	assert.equal(pathOfUri('/plain/a.pb'), '/plain/a.pb');
	assert.equal(pathOfUri('a.pb'), 'a.pb');
});

test('dirOfPath drops the file name', () => {
	assert.equal(dirOfPath('/ws/lib/helpers.pb'), '/ws/lib');
	assert.equal(dirOfPath('/a.pb'), '/');
	assert.equal(dirOfPath('a.pb'), '/');
});

test('an include target is resolved the way the compiler resolves it', () => {
	// relative to the file that writes the statement, not to the root file
	assert.deepEqual(resolveIncludeTargets('/ws/lib/helpers.pb', 'deeper/more.pbi'), [
		'/ws/lib/deeper/more.pbi',
	]);
	assert.deepEqual(resolveIncludeTargets('/ws/lib/helpers.pb', '../common/x.pbi'), ['/ws/common/x.pbi']);
	assert.deepEqual(resolveIncludeTargets('/ws/lib/helpers.pb', 'x.pbi'), ['/ws/lib/x.pbi']);
	// Windows writes its separators the other way round
	assert.deepEqual(resolveIncludeTargets('/ws/a.pb', 'sub\\x.pbi'), ['/ws/sub/x.pbi']);
	// absolute targets are used as written
	assert.deepEqual(resolveIncludeTargets('/ws/a.pb', '/shared/x.pbi'), ['/shared/x.pbi']);
	// and the IncludePath directories are tried after the file's own directory
	assert.deepEqual(resolveIncludeTargets('/ws/a.pb', 'x.pbi', ['/inc']), [
		'/ws/x.pbi',
		'/inc/x.pbi',
	]);
	assert.deepEqual(resolveIncludeTargets('/ws/a.pb', ''), []);
});

test('the parser records IncludePath alongside IncludeFile', () => {
	const document = parseDocument(
		'file:///ws/a.pb',
		['IncludePath "libs"', 'IncludeFile "x.pbi"', 'XIncludeFile "y.pbi"'].join('\n'),
	);
	assert.deepEqual(document.includePaths, ['libs']);
	assert.deepEqual(document.includes, ['x.pbi', 'y.pbi']);
});

test('a chain shares its symbols with every file on it', () => {
	const pool = poolOf({
		'/ws/main.pb': 'IncludeFile "lib/a.pbi"',
		'/ws/lib/a.pbi': 'XIncludeFile "deeper/b.pbi"',
		'/ws/lib/deeper/b.pbi': 'Procedure Deep()\nEndProcedure',
		'/ws/unrelated.pb': 'Procedure Other()\nEndProcedure',
	});

	const expected = ['file:///ws/main.pb', 'file:///ws/lib/a.pbi', 'file:///ws/lib/deeper/b.pbi'];
	for (const uri of expected) {
		assert.deepEqual(
			[...includeGroup(uri, pool)].sort(),
			[...expected].sort(),
			`${uri} should see the whole chain`,
		);
	}
	assert.ok(
		!includeGroup('file:///ws/main.pb', pool).has('file:///ws/unrelated.pb'),
		'a file no include reaches stays out',
	);
});

test('a cycle terminates and keeps the group together', () => {
	const pool = poolOf({
		'/ws/a.pb': 'IncludeFile "b.pb"',
		'/ws/b.pb': 'IncludeFile "a.pb"',
	});
	assert.deepEqual([...includeGroup('file:///ws/a.pb', pool)].sort(), ['file:///ws/a.pb', 'file:///ws/b.pb']);
});

test('include targets that do not exist are ignored', () => {
	const pool = poolOf({
		'/ws/a.pb': ['IncludeFile "nope.pbi"', 'IncludeFile "b.pb"'].join('\n'),
		'/ws/b.pb': 'Procedure B()\nEndProcedure',
	});
	assert.deepEqual([...includeGroup('file:///ws/a.pb', pool)].sort(), ['file:///ws/a.pb', 'file:///ws/b.pb']);
});

test('an IncludePath directory is searched relative to the file that declares it', () => {
	const pool = poolOf({
		'/ws/main.pb': 'IncludeFile "lib/a.pbi"',
		'/ws/lib/a.pbi': ['IncludePath "libs"', 'IncludeFile "b.pbi"'].join('\n'),
		'/ws/lib/libs/b.pbi': 'Procedure B()\nEndProcedure',
	});
	assert.ok(includeGroup('file:///ws/main.pb', pool).has('file:///ws/lib/libs/b.pbi'));
});

test('a case difference in a target still finds the file', () => {
	const pool = poolOf({
		'/ws/Main.pb': 'IncludeFile "LIB/Helpers.PBI"',
		'/ws/lib/helpers.pbi': 'Procedure H()\nEndProcedure',
	});
	assert.ok(includeGroup('file:///ws/Main.pb', pool).has('file:///ws/lib/helpers.pbi'));
});

test('uriForPath matches on the decoded, case-insensitive path', () => {
	const pool = poolOf({ '/ws/my files/a.pb': '' });
	assert.equal(uriForPath(pool, '/ws/my files/a.pb'), 'file:///ws/my files/a.pb');
	assert.equal(uriForPath(pool, '/WS/MY FILES/A.PB'), 'file:///ws/my files/a.pb');
	assert.equal(uriForPath(pool, '/ws/other.pb'), undefined);
});

test('the group is bounded so a huge project cannot stall a keystroke', () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 20; i++) files[`/ws/${i}.pb`] = `IncludeFile "${i + 1}.pb"`;
	files['/ws/20.pb'] = '';
	const group = includeGroup('file:///ws/0.pb', poolOf(files), 5);
	assert.equal(group.size, 5);
});

test('a group carries fields as well, but not the document itself', () => {
	const pool = poolOf({
		'/ws/main.pb': ['IncludeFile "lib/shapes.pbi"', 'Define p.Shape'].join('\n'),
		'/ws/lib/shapes.pbi': [
			'Structure Shape',
			'\twidth.i',
			'\theight.i',
			'EndStructure',
			'Procedure Draw()',
			'EndProcedure',
			'#MAX = 3',
		].join('\n'),
	});
	const group = includeGroup('file:///ws/main.pb', pool);
	const symbols = groupSymbols(group, pool, 'file:///ws/main.pb');
	const names = symbols.map((symbol) => symbol.name);

	assert.ok(symbols.some((s) => s.kind === 'field' && s.name === 'width'), 'fields come along');
	assert.ok(names.includes('Shape'), 'module-level names too');
	assert.ok(names.includes('Draw'));
	assert.ok(names.includes('#MAX'), 'constants are module level');
	assert.ok(!names.includes('p'), 'the document being completed in is left out');
});
