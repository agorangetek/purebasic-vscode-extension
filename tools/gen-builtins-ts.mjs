#!/usr/bin/env node
/*
 * Writes the generated TypeScript data modules from their JSON:
 *
 *   src/data/pb-builtins.json   -> src/data/pb-builtins.ts
 *   src/data/pb-constants.json  -> src/data/pb-constants.ts
 *
 * tools/gen-data.mjs and tools/gen-constants.mjs produce the JSON, but each
 * needs something this repository does not carry -- a checkout of the PureBasic
 * IDE, and an installed PureBasic help -- and the JSON is also what the grammar
 * is generated from.  The halves can therefore be edited apart, and they were:
 * nine reserved words added to the JSON reached the syntax highlighter and NOT
 * the completion list, because the extension imports the .ts and esbuild
 * bundles it.  The grammar guard added in 0.1.20 did not cover it, so it
 * shipped in 0.1.22.
 *
 * Making every .ts a pure function of its .json removes the possibility: the
 * JSON is the single source, `npm run build` regenerates the .ts from it, and
 * --check fails a build whose halves disagree.
 *
 * Usage:
 *   node tools/gen-builtins-ts.mjs           write the .ts files from the .json
 *   node tools/gen-builtins-ts.mjs --check   fail if either pair disagrees
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');
export const jsonFile = join(root, 'src', 'data', 'pb-builtins.json');
export const tsFile = join(root, 'src', 'data', 'pb-builtins.ts');
export const constantsJsonFile = join(root, 'src', 'data', 'pb-constants.json');
export const constantsTsFile = join(root, 'src', 'data', 'pb-constants.ts');

/*
 * Each list runs to a couple of thousand entries.  Emitted as one literal,
 * TypeScript gives up on the inferred type ("expression produces a union type
 * that is too complex to represent"), so each is written in chunks and spread
 * back together -- every chunk stays small enough to check.
 */
const CHUNK = 250;

/** The array in `items`, cut into chunks small enough for TypeScript. */
function chunksOf(items) {
	const chunks = [];
	for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));
	return chunks;
}

/** The one true text of src/data/pb-builtins.ts, for a given data object. */
export function serialiseBuiltinsTs(data) {
	const items = data.items ?? [];
	const meta = { ...data };
	delete meta.items;

	const chunks = chunksOf(items);

	const lines = [
		'/* Generated from src/data/pb-builtins.json -- do not edit by hand.',
		` * Source: ${data.source}`,
		' * Regenerate with: npm run gen-builtins-ts (or npm run gen-data)',
		' */',
		"import type { PbBuiltin, PbBuiltinData } from '../service/types.ts';",
		'',
	];
	chunks.forEach((chunk, i) => {
		lines.push(`const ITEMS_${i}: PbBuiltin[] = ${JSON.stringify(chunk)};`);
	});
	lines.push('');
	lines.push(`const ITEMS: PbBuiltin[] = [${chunks.map((_, i) => `...ITEMS_${i}`).join(', ')}];`);
	lines.push('');
	lines.push(`export const PB_BUILTINS: PbBuiltinData = { ...${JSON.stringify(meta)}, items: ITEMS };`);
	lines.push('');
	return lines.join('\n');
}

/** The one true text of src/data/pb-constants.ts, for a given data object. */
export function serialiseConstantsTs(data) {
	const items = data.items ?? [];
	const meta = { ...data };
	delete meta.items;

	const chunks = chunksOf(items);

	const lines = [
		'/* Generated from src/data/pb-constants.json -- do not edit by hand.',
		` * Source: ${data.source}`,
		' * Regenerate with: npm run gen-builtins-ts (or npm run gen-constants)',
		' */',
		"import type { PbBuiltinConstant, PbConstantData } from '../service/types.ts';",
		'',
	];
	chunks.forEach((chunk, i) => {
		lines.push(`const CONSTANTS_${i}: PbBuiltinConstant[] = ${JSON.stringify(chunk)};`);
	});
	lines.push('');
	lines.push(
		`const CONSTANTS: PbBuiltinConstant[] = [${chunks.map((_, i) => `...CONSTANTS_${i}`).join(', ')}];`,
	);
	lines.push('');
	lines.push(`export const PB_CONSTANTS: PbConstantData = { ...${JSON.stringify(meta)}, items: CONSTANTS };`);
	lines.push('');
	return lines.join('\n');
}

const runDirectly =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runDirectly) {
	const pairs = [
		{ json: jsonFile, ts: tsFile, serialise: serialiseBuiltinsTs, what: 'items' },
		{
			json: constantsJsonFile,
			ts: constantsTsFile,
			serialise: serialiseConstantsTs,
			what: 'constants',
		},
	];

	if (process.argv.includes('--check')) {
		let stale = 0;
		for (const pair of pairs) {
			const data = JSON.parse(readFileSync(pair.json, 'utf8'));
			const onDisk = existsSync(pair.ts) ? readFileSync(pair.ts, 'utf8') : '';
			if (onDisk !== pair.serialise(data)) {
				console.error(
					`stale: ${pair.ts} is not what ${pair.json} describes.\n` +
						'       run `npm run gen-builtins-ts` and commit the result.',
				);
				stale++;
			}
		}
		if (stale > 0) process.exit(1);
		console.log(`up to date: ${tsFile} and ${constantsTsFile}`);
	} else {
		for (const pair of pairs) {
			const data = JSON.parse(readFileSync(pair.json, 'utf8'));
			writeFileSync(pair.ts, pair.serialise(data));
			console.log(`wrote ${pair.ts}`);
			console.log(`  ${data.items?.length ?? 0} ${pair.what}, ${data.count ?? 0} expected`);
		}
	}
}
