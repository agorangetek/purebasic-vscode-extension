import { PB_BUILTINS } from '../data/pb-builtins.ts';
import type { PbBlock, PbBuiltin } from './types.ts';

const byName = new Map<string, PbBuiltin>();
for (const item of PB_BUILTINS.items) {
	if (!byName.has(item.lower)) byName.set(item.lower, item);
}

// Keywords from the user's KeywordsData.pbi, learned at startup
let overlay: readonly PbBuiltin[] = [];

export function setExtraKeywords(items: readonly PbBuiltin[]): void {
	overlay = items;
	for (const item of items) {
		if (!byName.has(item.lower)) byName.set(item.lower, item);
	}
}

export function extraKeywords(): readonly PbBuiltin[] {
	return overlay;
}

export function lookupBuiltin(name: string): PbBuiltin | undefined {
	return byName.get(name.toLowerCase().replace(/^\*/, ''));
}

export function allBuiltins(): readonly PbBuiltin[] {
	return overlay.length ? [...PB_BUILTINS.items, ...overlay] : PB_BUILTINS.items;
}

export function generatedKeywordCanonical(): Readonly<Record<string, string>> {
	return PB_BUILTINS.keywordCanonical;
}

export function builtinCommands(): readonly PbBuiltin[] {
	return PB_BUILTINS.items.filter((i) => i.kind !== 'keyword');
}

export function builtinKeywords(): readonly PbBuiltin[] {
	return allBuiltins().filter((i) => i.kind === 'keyword');
}

export function builtinSource(): string {
	return PB_BUILTINS.source;
}

export function builtinCount(): number {
	return PB_BUILTINS.count + overlay.length;
}

export function allBlocks(): readonly PbBlock[] {
	return PB_BUILTINS.blocks;
}

export function keywordCanonical(): Readonly<Record<string, string>> {
	if (overlay.length === 0) return PB_BUILTINS.keywordCanonical;
	const merged: Record<string, string> = { ...PB_BUILTINS.keywordCanonical };

	for (const item of overlay) merged[item.lower] ??= item.name;
	return merged;
}

export function builtinTypeSuffixes(): readonly string[] {
	return PB_BUILTINS.typeSuffixes;
}

export function canonicalKeyword(word: string): string | undefined {
	const lower = word.toLowerCase();
	if (Object.hasOwn(PB_BUILTINS.keywordCanonical, lower)) {
		return PB_BUILTINS.keywordCanonical[lower];
	}
	return byName.get(lower)?.kind === 'keyword' ? byName.get(lower)?.name : undefined;
}

export function isCompletableName(name: string): boolean {
	if (!/^[A-Za-z_#]/.test(name)) return false;
	if (/\s/.test(name)) return false;
	return true;
}

export function firstSignature(item: PbBuiltin): string {
	return item.signatures?.[0]?.text ?? item.name;
}

export function declarationBlock(text: string): string {
	return '```purebasic\n' + text + '\n```';
}

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
