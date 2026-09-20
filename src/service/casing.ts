/*
 * Canonical casing.
 *
 * PureBasic is case-insensitive, so rewriting an identifier's case can never
 * change what a program means -- but it makes code read consistently.
 *
 * The rule is one line long: everything the language provides is spelled the
 * way the manual spells it, and nothing else is touched.
 *
 *   - keywords and library commands are folded to their canonical spelling:
 *     `endprocedure` -> `EndProcedure`, `redim` -> `ReDim`, `foreach` ->
 *     `ForEach`, `messagerequester` -> `MessageRequester`;
 *   - the user's own identifiers are the user's business and are left exactly
 *     as written -- procedures, structures, variables, constants, labels and
 *     parameters alike (`myProc`, `Point`, `*pBuffer`, `name$`).
 *
 * The sigils are part of a PureBasic name (`*p` and `p` are different
 * variables, `name$` is a string), so they are carried through untouched while
 * the letters between them are re-cased.
 *
 * Comments and string literals are left alone too: the spelling of a word
 * inside a message is part of the text, not of the code.
 */
import { PB_BUILTINS } from '../data/pb-builtins.ts';
import { maskSource, parameterNames } from './parser.ts';
import type { PbSymbol } from './types.ts';

export interface CasingResult {
	/** The rewritten text. */
	text: string;
	/** How many identifiers were changed. */
	changes: number;
}

/** An identifier, with the sigil PureBasic treats as part of the name. */
const IDENTIFIER = /(\*|@|\?)?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Lower-cased name -> canonical spelling, built once. */
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

/**
 * Rewrite every identifier that has a known canonical spelling, and leave the
 * user's own names exactly as written.
 *
 * `declaredSymbols` (from parseDocument) is what keeps a procedure called
 * `debug` from being rewritten to the language's `Debug`, and a local `pointer`
 * from becoming anything at all.
 */
export function canonicalizeIdentifiers(
	text: string,
	declaredSymbols: readonly PbSymbol[] = [],
): CasingResult {
	/** Every name the user declared, lower-cased, so no language rule claims one. */
	const declared = new Set<string>();
	const add = (name: string) => {
		const key = name.replace(/^[*@?]/, '').toLowerCase();
		if (key.length > 0) declared.add(key);
	};
	for (const symbol of declaredSymbols) {
		add(symbol.name);
		// a procedure's parameters are the user's names too
		for (const parameter of parameterNames(symbol.params)) add(parameter);
	}

	const maskedLines = maskSource(text);
	// keep the original line separators (\r\n, \r or \n) exactly as they were
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
			// maskSource blanks comments and strings in place, so a differing
			// character means this identifier is not code
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
