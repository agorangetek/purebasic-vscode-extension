/*
 * Lookup helpers over the generated PureBasic data (src/data/pb-builtins.ts,
 * produced from the PureBasic IDE's command and keyword tables by
 * tools/gen-data.mjs).
 */
import { PB_BUILTINS } from '../data/pb-builtins.ts';
import type { PbBlock, PbBuiltin } from './types.ts';

/** Case-insensitive lookup by name. */
const byName = new Map<string, PbBuiltin>();
for (const item of PB_BUILTINS.items) {
	if (!byName.has(item.lower)) byName.set(item.lower, item);
}

export function lookupBuiltin(name: string): PbBuiltin | undefined {
	return byName.get(name.toLowerCase().replace(/^\*/, ''));
}

export function allBuiltins(): readonly PbBuiltin[] {
	return PB_BUILTINS.items;
}

export function builtinCommands(): readonly PbBuiltin[] {
	return PB_BUILTINS.items.filter((i) => i.kind !== 'keyword');
}

export function builtinKeywords(): readonly PbBuiltin[] {
	return PB_BUILTINS.items.filter((i) => i.kind === 'keyword');
}

export function builtinSource(): string {
	return PB_BUILTINS.source;
}

export function builtinCount(): number {
	return PB_BUILTINS.count;
}

/** Compound statement blocks, from the IDE's folding-pair table. */
export function allBlocks(): readonly PbBlock[] {
	return PB_BUILTINS.blocks;
}

/** Every canonical keyword spelling, plus the canonical map. */
export function keywordCanonical(): Readonly<Record<string, string>> {
	return PB_BUILTINS.keywordCanonical;
}

export function builtinTypeSuffixes(): readonly string[] {
	return PB_BUILTINS.typeSuffixes;
}

/**
 * The manual's spelling of a reserved word, or undefined when `word` is not one.
 *
 * Reserved words only: a library command can also be a variable name
 * (`left`, `open`, `print`), so re-casing one as you type could rewrite a name
 * the author chose.  A keyword cannot be a variable name, so re-casing it is
 * always safe.
 */
export function canonicalKeyword(word: string): string | undefined {
	const lower = word.toLowerCase();
	if (!Object.hasOwn(PB_BUILTINS.keywordCanonical, lower)) return undefined;
	return PB_BUILTINS.keywordCanonical[lower];
}

/**
 * Whether a built-in's name can be typed as a bare word.  A handful of manual
 * entries name a syntax form rather than a token (`Debug Expression`,
 * `Operator []`), and those have no business in a completion list.
 */
export function isCompletableName(name: string): boolean {
	if (!/^[A-Za-z_#]/.test(name)) return false;
	if (/\s/.test(name)) return false;
	return true;
}

/** Full signature text, or the name, for hover. */
export function firstSignature(item: PbBuiltin): string {
	return item.signatures?.[0]?.text ?? item.name;
}

/** The manual signature, as a fenced code block. */
export function declarationBlock(text: string): string {
	return '```purebasic\n' + text + '\n```';
}

/** Markdown documentation for a built-in. */
export function builtinMarkdown(item: PbBuiltin): string {
	const parts: string[] = [];
	const signature = item.signatures?.[0];
	if (signature?.text) parts.push(declarationBlock(signature.text));
	else if (item.kind !== 'keyword') parts.push(declarationBlock(item.name));

	if (item.kind === 'keyword') {
		parts.push(`PureBasic keyword (${item.category}).`);
	} else {
		parts.push(`PureBasic library command${item.library ? ` from the \`${item.library}\` library` : ''}.`);
	}
	parts.push(`*Category: ${item.category}*`);
	return parts.join('\n\n');
}

/** The parameter list as a compact call label: MessageRequester(Title, Text, Flags). */
export function callLabel(name: string, params: readonly { name: string }[]): string {
	const args = params.map((p) => p.name).filter(Boolean);
	return args.length > 0 ? `${name}(${args.join(', ')})` : `${name}()`;
}
