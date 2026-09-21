/*
 * Take the parts of node-pty that are not shipped out of node_modules.
 *
 * The prebuilt binaries for each platform, the library and the licence are what
 * goes into the package.  Its sources, the winpty sources it vendors and the
 * debug symbols (megabytes each, and never loaded) are removed.  `npm install`
 * puts them all back.
 *
 *   node tools/trim-pty.mjs
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'node_modules/node-pty';

const gone = [
	'deps',
	'src',
	'scripts',
	'third_party',
];

for (const path of gone) rmSync(join(root, path), { recursive: true, force: true });

/** Remove every file the predicate matches, and the directories left empty. */
function prune(directory, matches) {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return true;
	}
	let empty = true;
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!prune(path, matches)) empty = false;
		} else if (matches(entry.name)) {
			rmSync(path, { force: true });
		} else {
			empty = false;
		}
	}
	if (empty) rmSync(directory, { recursive: true, force: true });
	return empty;
}

prune(root, (name) => name.endsWith('.pdb') || name.endsWith('.test.js') || name.endsWith('.map'));

if (statSync(root, { throwIfNoEntry: false })) {
	console.log('trimmed node-pty to what Windows needs');
}
