/*
 * Tests for the block helpers: the scaffold a completion item inserts, the
 * statement heads offered inside a block, and the opener detection that Enter
 * leans on.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allBlocks } from '../src/service/builtins.ts';
import { blockBody, blockContinuations, blockOpenerAt } from '../src/service/blocks.ts';

const BLOCKS = allBlocks();

test('a finished line is recognised as opening a block', () => {
	const opens = (line: string) => blockOpenerAt(line, BLOCKS)?.opener;

	assert.equal(opens('procedure test()'), 'Procedure', 'however it is cased');
	assert.equal(opens('procedure'), 'Procedure', 'a bare keyword opens the block');
	assert.equal(opens('ProcedureDLL Thing()'), 'ProcedureDLL');
	assert.equal(opens('\tstructure Point'), 'Structure', 'indentation is fine');
	assert.equal(opens('For i = 0 To 10'), 'For');
	assert.equal(opens('ForEach item()'), 'ForEach');
	assert.equal(opens('Repeat'), 'Repeat');
	assert.equal(opens('While x > 1'), 'While');
	assert.equal(opens('With *p'), 'With');
	assert.equal(opens('If x > 1'), 'If');
	assert.equal(opens('CompilerIf #PB_Compiler_Debugger'), 'CompilerIf');
	assert.equal(opens('DeclareModule Foo'), 'DeclareModule');
});

test('a line that opens nothing is left alone', () => {
	const opens = (line: string) => blockOpenerAt(line, BLOCKS)?.opener;

	assert.equal(opens('If x > 1 : y = 2 : EndIf'), undefined, 'already terminated');
	assert.equal(opens('EndProcedure'), undefined, 'a terminator');
	assert.equal(opens('x = 1'), undefined, 'an assignment');
	assert.equal(opens(''), undefined);
	assert.equal(opens('   '), undefined);
	assert.equal(opens('; Procedure test()'), undefined, 'a comment is not code');
	assert.equal(opens('s = "Procedure test()"'), undefined, 'nor is a string');
	assert.equal(opens('Declare test()'), undefined, 'a prototype has no body');
});

test('a block opener gets its own terminator, not another block\'s', () => {
	assert.equal(blockOpenerAt('Procedure test()', BLOCKS)?.closers[0], 'EndProcedure');
	assert.equal(blockOpenerAt('Repeat', BLOCKS)?.closers[0], 'Until');
	assert.equal(blockOpenerAt('Structure Point', BLOCKS)?.closers[0], 'EndStructure');
	assert.equal(blockOpenerAt('ForEach item()', BLOCKS)?.closers[0], 'Next');
});

test('every block has a scaffold that opens and closes', () => {
	for (const block of BLOCKS) {
		const body = blockBody(block);
		assert.ok(body, `${block.opener} has no snippet`);
		assert.ok(
			body!.startsWith(block.opener),
			`${block.opener} inserts "${body!.split('\n')[0]}"`,
		);
		assert.ok(body!.includes(block.closers[0]), `${block.opener} does not insert ${block.closers[0]}`);
	}
});

test('the continuations cover every terminator and the branch heads', () => {
	const labels = new Set(blockContinuations(BLOCKS).map((c) => c.label));
	for (const closer of ['EndProcedure', 'EndIf', 'EndSelect', 'Next', 'Wend', 'Until', 'EndStructure']) {
		assert.ok(labels.has(closer), `${closer} is offered`);
	}
	for (const branch of ['Case', 'Default', 'Else', 'ElseIf', 'CompilerCase', 'Break', 'Continue']) {
		assert.ok(labels.has(branch), `${branch} is offered`);
	}
});
