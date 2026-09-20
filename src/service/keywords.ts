/*
 * Keyword refresh from the PureBasic IDE's own table.
 *
 * The extension ships a keyword list generated from the IDE's data.  When a new
 * PureBasic comes out that list is stale until this extension is rebuilt, so the
 * user can point `purebasic.keywords.path` at a
 * `PureBasicIDE/KeywordsData.pbi` and the new words are picked up at startup.
 *
 * Note what this is NOT: the file does not ship with a PureBasic installation
 * (the app bundle has catalogs, colorschemes, compilers, purelibraries, ... and
 * no keyword table), so the path points at the IDE source.  It is also not
 * tools/gen-data.mjs, which needs three further files that only exist in that
 * source tree; this reads the one file that carries the reserved words.
 *
 * Everything here is editor-agnostic and side-effect free, so the paths, the
 * guards and the merge can be tested without a running editor.
 */
import type { PbBuiltin } from './types.ts';

/** A word that can be typed on its own, which is all the grammar can alternate. */
const TYPEABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The `Data$ "Name"` lines of the IDE's `BasicKeywords:` section.
 *
 * The file is compiled by the IDE under `CompilerIf #SpiderBasic` /
 * `CompilerIf Not #SpiderBasic` guards, and this is a PureBasic extension, so
 * `#SpiderBasic` counts as FALSE: `Not #SpiderBasic` includes, a bare
 * `#SpiderBasic` excludes.  That is what keeps SpiderBasic's DisableJS and
 * EnableJS from becoming PureBasic keywords.
 *
 * The `ASMKeywords:` section is skipped: its words come from an IncludeFile, and
 * inline assembly is a scope of its own here rather than a keyword list.
 */
export function parseKeywordsData(text: string): string[] {
	const names: string[] = [];
	const included: boolean[] = [];
	let section: string | undefined;

	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith(';')) continue;

		const label = /^([A-Za-z_]\w*):$/.exec(line);
		if (label) {
			section = label[1];
			included.length = 0;
			continue;
		}

		const guard = /^CompilerIf\s+(Not\s+)?#SpiderBasic\b/i.exec(line);
		if (guard) {
			included.push(Boolean(guard[1]));
			continue;
		}
		if (/^CompilerElse\b/i.test(line)) {
			if (included.length) included[included.length - 1] = !included[included.length - 1];
			continue;
		}
		if (/^Compiler(EndIf|Select|EndSelect|Case|Default|Error|Warning)\b/i.test(line)) {
			if (/^CompilerEndIf\b/i.test(line)) included.pop();
			continue;
		}

		const data = /^Data\$\s*"([^"]*)"/.exec(line);
		if (!data) continue;
		if (section !== 'BasicKeywords') continue;
		if (!included.every(Boolean)) continue;

		const name = data[1]!.trim();
		if (TYPEABLE.test(name) && !names.includes(name)) names.push(name);
	}

	return names;
}

/** The names in `found` that are not already known, compared case-insensitively. */
export function newKeywordNames(known: Iterable<string>, found: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const name of known) seen.add(name.toLowerCase());
	const out: string[] = [];
	for (const name of found) {
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(name);
	}
	return out;
}

/**
 * A completion/hover entry for a keyword we learned at runtime.  It carries no
 * signature -- the IDE table has none -- and is marked as coming from the file
 * rather than from the generated data.
 */
export function keywordEntry(name: string): PbBuiltin {
	return {
		id: `${name.toLowerCase()}|keyword`,
		name,
		lower: name.toLowerCase(),
		kind: 'keyword',
		category: 'KeywordsData',
	};
}

/**
 * The grammar, with `names` added to one keyword alternation.
 *
 * Strictly additive: the existing alternation is parsed, the new words are
 * appended, and everything else in the file is left byte for byte as it was.
 * That matters because this rewrites the grammar the editor loads -- regenerating
 * it from scratch here would silently drop every rule the generator adds.
 *
 * Returns `added: []` when there is nothing to do, so the caller can skip the
 * write and leave the file untouched.
 */
export function addKeywordsToGrammar(
	grammarText: string,
	names: readonly string[],
	scope = 'keyword.other.purebasic',
): { text: string; added: string[] } {
	let grammar: {
		repository?: Record<string, { patterns?: { name?: string; match?: string }[] }>;
	};
	try {
		grammar = JSON.parse(grammarText) as typeof grammar;
	} catch {
		return { text: grammarText, added: [] };
	}

	const patterns = grammar.repository?.['keywords']?.patterns;
	const target = patterns?.find((p) => p.name === scope && typeof p.match === 'string');
	if (!patterns || !target?.match) return { text: grammarText, added: [] };

	/*
	 * A word already known in ANY keyword group is not new: `Procedure` lives in
	 * keyword.control, and adding it here as well would put one word in two
	 * alternations and leave it to rule order which colour it got.
	 */
	const have = new Set<string>();
	for (const pattern of patterns) {
		const words = wordsOf(pattern.match);
		for (const word of words) have.add(word.toLowerCase());
	}

	// `(?i)\b(?:A|B|C)\b` -- keep the guard around the alternation intact
	const parsed = /^(.*\(\?:)(.*)(\).*)$/.exec(target.match);
	if (!parsed) return { text: grammarText, added: [] };

	const existing = parsed[2]!.split('|');
	const added: string[] = [];
	for (const name of names) {
		const lower = name.toLowerCase();
		if (have.has(lower) || !TYPEABLE.test(name)) continue;
		have.add(lower);
		existing.push(name);
		added.push(name);
	}
	if (added.length === 0) return { text: grammarText, added: [] };

	target.match = parsed[1] + existing.join('|') + parsed[3];
	return { text: JSON.stringify(grammar, null, '\t') + '\n', added };
}

/** The words of one `(?i)\b(?:A|B|C)\b` alternation. */
function wordsOf(match: string | undefined): string[] {
	if (typeof match !== 'string') return [];
	const parsed = /^(.*\(\?:)(.*)(\).*)$/.exec(match);
	return parsed ? parsed[2]!.split('|') : [];
}
