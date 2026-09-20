#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');
export const jsonFile = join(root, 'src', 'data', 'pb-builtins.json');
export const tsFile = join(root, 'src', 'data', 'pb-builtins.ts');

const CHUNK = 250;

export function serialiseBuiltinsTs(data) {
	const items = data.items ?? [];
	const meta = { ...data };
	delete meta.items;

	const chunks = [];
	for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));

	const lines = [
		'/* Generated from src/data/pb-builtins.json -- do not edit; run npm run gen-builtins-ts.',
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
