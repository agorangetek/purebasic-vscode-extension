#!/usr/bin/env node
/*
 * Writes src/data/pb-builtins.ts from src/data/pb-builtins.json.
 *
 * tools/gen-data.mjs produces both files in one run, but it needs a checkout of
 * the PureBasic IDE, and the JSON is also what the grammar is generated from.
 * The two halves can therefore be edited apart -- and they were: nine reserved
 * words added to the JSON reached the syntax highlighter and NOT the completion
 * list, because the extension imports the .ts and esbuild bundles it.  The
 * grammar guard added in 0.1.20 did not cover it, so it shipped in 0.1.22.
 *
 * Making the .ts a pure function of the .json removes the possibility: the JSON
 * is the single source, `npm run build` regenerates the .ts from it, and
 * --check fails a build whose halves disagree.
 *
 * Usage:
 *   node tools/gen-builtins-ts.mjs           write the .ts from the .json
 *   node tools/gen-builtins-ts.mjs --check   fail if the two disagree
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');
export const jsonFile = join(root, 'src', 'data', 'pb-builtins.json');
export const tsFile = join(root, 'src', 'data', 'pb-builtins.ts');

/*
 * The item list runs to a couple of thousand entries.  Emitted as one literal,
 * TypeScript gives up on the inferred type ("expression produces a union type
 * that is too complex to represent"), so it is written in chunks and spread
 * back together -- each chunk stays small enough to check.
 */
const CHUNK = 250;

/** The one true text of src/data/pb-builtins.ts, for a given data object. */
export function serialiseBuiltinsTs(data) {
	const items = data.items ?? [];
	const meta = { ...data };
	delete meta.items;

	const chunks = [];
	for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));

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

const runDirectly =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runDirectly) {
	const data = JSON.parse(readFileSync(jsonFile, 'utf8'));
	const text = serialiseBuiltinsTs(data);

	if (process.argv.includes('--check')) {
		const onDisk = existsSync(tsFile) ? readFileSync(tsFile, 'utf8') : '';
		if (onDisk !== text) {
			console.error(
				`stale: ${tsFile} is not what ${jsonFile} describes.\n` +
					'       run `npm run gen-builtins-ts` and commit the result.',
			);
			process.exit(1);
		}
		console.log(`up to date: ${tsFile}`);
	} else {
		writeFileSync(tsFile, text);
		console.log(`wrote ${tsFile}`);
		console.log(`  ${data.items?.length ?? 0} items, ${data.count ?? 0} expected`);
	}
}
