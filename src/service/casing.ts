import { PB_BUILTINS } from '../data/pb-builtins.ts';
import { maskSource, parameterNames } from './parser.ts';
import type { PbSymbol } from './types.ts';

export interface CasingResult {
	text: string;

	changes: number;
}

const IDENTIFIER = /(\*|@|\?)?([A-Za-z_][A-Za-z0-9_]*)/g;

const CANONICAL: ReadonlyMap<string, string> = (() => {
	const map = new Map<string, string>();
	for (const [lower, canonical] of Object.entries(PB_BUILTINS.keywordCanonical)) {
		map.set(lower.toLowerCase(), canonical);
	}
	for (const item of PB_BUILTINS.items) {
		if (!map.has(item.lower)) map.set(item.lower, item.name);
	}
	return map;
})();

export function canonicalizeIdentifiers(
	text: string,
	declaredSymbols: readonly PbSymbol[] = [],
): CasingResult {
	const declared = new Set<string>();
	const add = (name: string) => {
		const key = name.replace(/^[*@?]/, '').toLowerCase();
		if (key.length > 0) declared.add(key);
	};
	for (const symbol of declaredSymbols) {
		add(symbol.name);

		for (const parameter of parameterNames(symbol.params)) add(parameter);
	}

	const maskedLines = maskSource(text);

	const parts = text.split(/(\r\n|\r|\n)/);
	let changes = 0;
	let line = 0;

	for (let i = 0; i < parts.length; i += 2) {
		const source = parts[i] ?? '';
		const masked = maskedLines[line++] ?? '';
		let out = '';
		let last = 0;
		for (const match of source.matchAll(IDENTIFIER)) {
			const start = match.index;

			if (masked[start] !== source[start]) continue;

			const sigil = match[1] ?? '';
			const name = match[2]!;
			const lower = name.toLowerCase();
			if (declared.has(lower)) continue;

			const canonical = CANONICAL.get(lower);
			if (!canonical || canonical === name) continue;

			out += source.slice(last, start) + sigil + canonical;
			last = start + match[0].length;
			changes++;
		}
		parts[i] = out + source.slice(last);
	}

	return { text: parts.join(''), changes };
}
