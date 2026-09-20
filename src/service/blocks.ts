/*
 * Editor-side sugar for PureBasic's compound statement blocks.
 *
 * The language facts -- which word opens a block and which terminator(s) close
 * it -- come from the IDE's folding-pair table and are generated into
 * src/data/pb-builtins.ts (tools/gen-data.mjs).  What lives here is only the
 * part that table cannot supply: the shape of the snippet a user gets when they
 * accept an opener, and which statement heads to offer inside a block.
 *
 * Snippet bodies are composed from the generated opener and closer instead of
 * being spelled out, so the inserted text is always cased like the label the
 * completion list showed.
 */
import type { PbBlock } from './types.ts';

/**
 * Statement heads that continue a block without opening one.  Spelled out
 * because they are not folding pairs: they belong to a block that is already
 * open.
 */
const EXTRA_CONTINUATIONS: readonly { label: string; detail: string }[] = [
	{ label: 'Case', detail: 'Select branch' },
	{ label: 'Default', detail: 'default Select branch' },
	{ label: 'Else', detail: 'alternative branch' },
	{ label: 'ElseIf', detail: 'conditional branch' },
	{ label: 'CompilerCase', detail: 'CompilerSelect branch' },
	{ label: 'CompilerDefault', detail: 'default CompilerSelect branch' },
	{ label: 'CompilerElse', detail: 'alternative compiler branch' },
	{ label: 'CompilerElseIf', detail: 'conditional compiler branch' },
	{ label: 'Break', detail: 'leave the loop' },
	{ label: 'Continue', detail: 'next iteration of the loop' },
];

/**
 * Snippet bodies keyed by lower-cased opener.  `$1`-style tab stops are filled
 * in order and `$0` is where the cursor ends up.  An opener with no entry here
 * is inserted as plain text.
 */
const BLOCK_BODIES = new Map<string, (b: PbBlock) => string>([
	['procedure', (b) => `${b.opener} \${1:name}(\${2})\n\t$0\n${b.closers[0]}`],
	['proceduredll', (b) => `${b.opener} \${1:name}(\${2})\n\t$0\n${b.closers[0]}`],
	['procedurec', (b) => `${b.opener} \${1:name}(\${2})\n\t$0\n${b.closers[0]}`],
	['procedurecdll', (b) => `${b.opener} \${1:name}(\${2})\n\t$0\n${b.closers[0]}`],
	['structure', (b) => `${b.opener} \${1:name}\n\t$0\n${b.closers[0]}`],
	['structureunion', (b) => `${b.opener}\n\t$0\n${b.closers[0]}`],
	['interface', (b) => `${b.opener} \${1:name}\n\t$0\n${b.closers[0]}`],
	['module', (b) => `${b.opener} \${1:name}\n\t$0\n${b.closers[0]}`],
	['declaremodule', (b) => `${b.opener} \${1:name}\n\t$0\n${b.closers[0]}`],
	['enumeration', (b) => `${b.opener} \${1:name}\n\t\$2\n${b.closers[0]}`],
	['enumerationbinary', (b) => `${b.opener} \${1:name}\n\t\$2\n${b.closers[0]}`],
	['macro', (b) => `${b.opener} \${1:name}(\${2})\n\t$0\n${b.closers[0]}`],
	['datasection', (b) => `${b.opener}\n\t\${1:Data.i 0}\n${b.closers[0]}`],
	['import', (b) => `${b.opener} "\${1:library}"\n\t$0\n${b.closers[0]}`],
	['importc', (b) => `${b.opener} "\${1:library}"\n\t$0\n${b.closers[0]}`],
	['if', (b) => `${b.opener} \${1:condition}\n\t$0\n${b.closers[0]}`],
	['select', (b) => `${b.opener} \${1:expression}\n\tCase \${2:value}\n\t\t$0\n${b.closers[0]}`],
	['for', (b) => `${b.opener} \${1:i} = \${2:0} To \${3:n}\n\t$0\n${b.closers[0]}`],
	['foreach', (b) => `${b.opener} \${1:list}()\n\t$0\n${b.closers[0]}`],
	['while', (b) => `${b.opener} \${1:condition}\n\t$0\n${b.closers[0]}`],
	['repeat', (b) => `${b.opener}\n\t$0\nUntil \${1:condition}`],
	['compilerif', (b) => `${b.opener} \${1:condition}\n\t$0\n${b.closers[0]}`],
	[
		'compilerselect',
		(b) => `${b.opener} \${1:expression}\n\tCompilerCase \${2:value}\n\t\t$0\n${b.closers[0]}`,
	],
	['headersection', (b) => `${b.opener}\n\t$0\n${b.closers[0]}`],
	['with', (b) => `${b.opener} \${1:expression}\n\t$0\n${b.closers[0]}`],
]);

/** The snippet that expands `block` into a whole skeleton, if there is one. */
export function blockBody(block: PbBlock): string | undefined {
	return BLOCK_BODIES.get(block.opener.toLowerCase())?.(block);
}

/**
 * Statement heads to offer at the start of a statement: every terminator, plus
 * the branch and loop-control statements used inside a block.
 */
export function blockContinuations(blocks: readonly PbBlock[]): { label: string; detail: string }[] {
	const out: { label: string; detail: string }[] = [];
	const seen = new Set<string>();
	for (const block of blocks) {
		for (const closer of block.closers) {
			const key = closer.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ label: closer, detail: `close the ${block.opener.toLowerCase()} block` });
		}
	}
	for (const { label, detail } of EXTRA_CONTINUATIONS) {
		if (seen.has(label.toLowerCase())) continue;
		seen.add(label.toLowerCase());
		out.push({ label, detail });
	}
	return out;
}

/** Whether a statement is a prototype prefix, where the bare keyword is wanted. */
export function isDeclarationPrefix(before: string): boolean {
	return /^\s*(?:declare|prototype|import)\s*$/i.test(before);
}

/**
 * Whether the cursor is right after a word that expects a name (rather than a
 * fresh statement) -- `Procedure`, `Structure`, `Module`, ... .
 */
export function expectsName(before: string): boolean {
	return /^\s*(?:runtime\s+)?(?:procedure|proceduredll|procedurec|procedurecdll|structure|interface|module|declaremodule|macro|enumeration|enumerationbinary)\s*$/i.test(
		before,
	);
}
