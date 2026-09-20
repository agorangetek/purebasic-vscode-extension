#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { serialiseBuiltinsTs } from './gen-builtins-ts.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const pbIde = process.argv[2] || process.env.PB_IDE || join(root, '..', 'PB IDE');
const commandsFile = join(pbIde, 'scripts', 'commands', 'pb_commands_full.json');
const namesFile = join(pbIde, 'scripts', 'commands', 'pb_commands.json');
const keywordsFile = join(pbIde, 'scripts', 'PureBasicKeywords.gd');

function splitParams(text) {
	const out = [];
	let depth = 0;
	let nextOptional = false;
	let currentOptional = false;
	let current = '';
	const push = () => {
		const cleaned = current.replace(/[[\]]/g, '').replace(/^,+/, '').trim();
		if (cleaned.length > 0) out.push({ text: cleaned, optional: currentOptional });
		current = '';
	};
	for (const ch of text) {
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === '[') nextOptional = true;
		if (ch === ',' && depth <= 0) {
			push();
			currentOptional = nextOptional;
			continue;
		}
		current += ch;
	}
	push();
	return out;
}

function parseParam(raw) {
	let text = raw.text.trim();
	const mode = raw.optional ? 'optional' : '';

	let type = '';
	const eq = text.search(/\s=\s/);
	let body = text;
	if (eq > 0) {
		type = text.slice(eq).trim();
		body = text.slice(0, eq).trim();
	}

	const dot = body.match(/^(.*?)(?:\.([A-Za-z_][A-Za-z0-9_-]*(?:\{[^}]*\})?))$/);
	let name = body;
	if (dot) {
		name = dot[1].trim();
		type = [dot[2], type].filter(Boolean).join(' ');
	}

	name = name.replace(/[,\s]+$/, '').trim();
	if (!/^[*@?]?[A-Za-z_#][A-Za-z0-9_]*\$?$/.test(name)) return undefined;
	return { mode, name, type };
}

function parseSignature(signature, name) {
	const entry = { text: signature.trim(), label: name, params: [], callIndex: -1 };
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const found = new RegExp(`\\b${escaped}\\s*\\(`, 'i').exec(signature);
	if (!found) return entry;
	entry.callIndex = found.index;

	const open = found.index + found[0].length - 1;
	let depth = 0;
	let close = -1;
	for (let i = open; i < signature.length; i++) {
		if (signature[i] === '(') depth++;
		else if (signature[i] === ')') {
			depth--;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close < 0) return entry;

	entry.label = signature.slice(found.index, close + 1).replace(/\s+/g, ' ').trim();
	entry.params = splitParams(signature.slice(open + 1, close))
		.map(parseParam)
		.filter(Boolean);
	return entry;
}

function readArray(source, name) {
	const m = new RegExp(`const ${name} := \\[([\\s\\S]*?)\\]`).exec(source);
	if (!m) return [];
	return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/* -------------------------------------------------------------------- input */

let commands;
let canonicalNames;
let keywordsSource;
try {
	commands = JSON.parse(readFileSync(commandsFile, 'utf8'));
	canonicalNames = JSON.parse(readFileSync(namesFile, 'utf8'));
	keywordsSource = readFileSync(keywordsFile, 'utf8');
} catch (error) {
	console.error(`could not read the PureBasic IDE data under ${pbIde}`);
	console.error(String(error));
	console.error('pass the path to a "PB IDE" checkout, or set PB_IDE');
	process.exit(1);
}

/* ----------------------------------------------------------------- keywords */

const canonicalBlock = /const CANONICAL := \{([\s\S]*?)\n\}/.exec(keywordsSource)?.[1] ?? '';
const canonical = new Map();
for (const m of canonicalBlock.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
	canonical.set(m[1].toLowerCase(), m[2]);
}

const CATEGORY_OF = {
	PROCEDURE: 'Procedures',
	CONTROL: 'Control Flow',
	LOOP: 'Control Flow',
	DATA: 'Data',
	DECLARE: 'Declarations',
	STRUCTURE: 'Structures',
	MODULE: 'Modules',
	MACRO: 'Macros',
	PREPROC: 'Compiler',
	IMPORT: 'Includes',
	ENUM: 'Enumerations',
	LIST: 'Containers',
	OPERATOR: 'Operators',
};

const typeSuffixes = readArray(keywordsSource, 'TYPE_SUFFIXES');

const keywordItems = [];
const seenKeyword = new Set();
for (const [group, category] of Object.entries(CATEGORY_OF)) {
	for (const lower of readArray(keywordsSource, group)) {
		const key = lower.toLowerCase();
		if (seenKeyword.has(key)) continue;
		seenKeyword.add(key);
		keywordItems.push({
			id: `${key}|keyword`,
			name: canonical.get(key) ?? lower,
			lower,
			kind: 'keyword',
			category,
		});
	}
}
// the word operators are keywords too, even though they read as operators
for (const lower of readArray(keywordsSource, 'OPERATOR')) {
	const key = lower.toLowerCase();
	if (seenKeyword.has(key)) continue;
	seenKeyword.add(key);
	keywordItems.push({
		id: `${key}|keyword`,
		name: canonical.get(key) ?? lower,
		lower,
		kind: 'keyword',
		category: 'Operators',
	});
}

/*
 * The IDE's own keyword table, PureBasicIDE/KeywordsData.pbi, on top of the
 * script data above.  The two do not agree: the script table is missing
 * List, Map, Array, As, CallDebugger, DebugLevel, DisableDebugger,
 * EnableDebugger and IncludePath, which the IDE highlights and autocompletes
 * like any other keyword.  Add whatever it knows and we do not.
 *
 * The entries sit inside CompilerIf #SpiderBasic / CompilerIf Not #SpiderBasic
 * guards, and this is a PureBasic extension, so #SpiderBasic counts as FALSE:
 * `Not #SpiderBasic` includes, a bare `#SpiderBasic` excludes.  That is what
 * keeps SpiderBasic's DisableJS/EnableJS out.
 */
function readIdeKeywords(file) {
	const included = [];
	const names = [];
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		const line = raw.trim();
		const guard = /^CompilerIf\s+(Not\s+)?#SpiderBasic\b/i.exec(line);
		if (guard) {
			// `Not #SpiderBasic` is true for us, a bare `#SpiderBasic` is not
			included.push(Boolean(guard[1]));
			continue;
		}
		if (/^CompilerElse\b/i.test(line)) {
			if (included.length) included[included.length - 1] = !included[included.length - 1];
			continue;
		}
		if (/^CompilerEndIf\b/i.test(line)) {
			included.pop();
			continue;
		}
		const data = /^Data\$\s*"([^"]+)"/.exec(line);
		if (data && included.every(Boolean)) names.push(data[1]);
	}
	return names;
}

const CATEGORY_OF_IDE_KEYWORD = {
	list: 'Containers',
	map: 'Containers',
	array: 'Containers',
	as: 'Declarations',
	calldebugger: 'Control Flow',
	debuglevel: 'Compiler',
	disabledebugger: 'Compiler',
	enabledebugger: 'Compiler',
	includepath: 'Includes',
};

const ideKeywordsFile = [join(pbIde, 'PureBasicIDE', 'KeywordsData.pbi'), join(pbIde, 'KeywordsData.pbi')].find(
	(file) => existsSync(file),
);

let supplemented = 0;
if (ideKeywordsFile) {
	for (const name of readIdeKeywords(ideKeywordsFile)) {
		const key = name.toLowerCase();
		if (seenKeyword.has(key)) continue;
		seenKeyword.add(key);
		canonical.set(key, name);
		keywordItems.push({
			id: `${key}|keyword`,
			name,
			lower: key,
			kind: 'keyword',
			category: CATEGORY_OF_IDE_KEYWORD[key] ?? 'Declarations',
		});
		supplemented++;
	}
}

const commandItems = [];
const seenCommand = new Set();
for (const command of commands) {
	const lower = String(command.name).toLowerCase();

	if (seenCommand.has(lower)) continue;
	seenCommand.add(lower);
	const name = canonicalNames.find((n) => n.toLowerCase() === lower) ?? command.name;
	const text = String(command.signature ?? name);
	const signature = parseSignature(text, name);

	const returns = signature.callIndex > 0 && text.slice(0, signature.callIndex).includes('=');
	commandItems.push({
		id: `${lower}|command`,
		name,
		lower,
		kind: returns ? 'function' : 'sub',
		category: command.library ? String(command.library) : 'Library',
		library: command.library ? String(command.library) : undefined,
		signatures: [signature],
	});
}

const foldingBlock = /static var FOLDING_PAIRS := \[([\s\S]*?)\n\]/.exec(keywordsSource)?.[1] ?? '';
const keywordCategory = new Map(keywordItems.map((k) => [k.lower, k.category]));
const blocks = [];
for (const m of foldingBlock.matchAll(
	/\{\s*"open":\s*"([^"]+)",\s*"close":\s*\[([^\]]*)\]\s*\}/g,
)) {
	const opener = canonical.get(m[1].toLowerCase()) ?? m[1];
	const closers = [...m[2].matchAll(/"([^"]+)"/g)].map(
		(c) => canonical.get(c[1].toLowerCase()) ?? c[1],
	);
	blocks.push({
		opener,
		closers,
		category: keywordCategory.get(m[1].toLowerCase()) ?? 'Blocks',
	});
}

const items = [...commandItems, ...keywordItems];

const out = {
	source: `PureBasic ${commandItems.length} library commands and ${keywordItems.length} keywords`,
	generatedFrom: pbIde,
	count: items.length,

	keywords: [...canonical.values()],
	keywordCanonical: Object.fromEntries(canonical),
	typeSuffixes,
	blocks,
	items,
};

mkdirSync(join(root, 'src', 'data'), { recursive: true });
const outFile = join(root, 'src', 'data', 'pb-builtins.json');
writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');

const tsFile = join(root, 'src', 'data', 'pb-builtins.ts');

writeFileSync(tsFile, serialiseBuiltinsTs(out));

const byLibrary = {};
for (const item of commandItems) byLibrary[item.category] = (byLibrary[item.category] ?? 0) + 1;
console.log(`wrote ${outFile}`);
console.log(`wrote ${tsFile}`);
console.log(`  ${keywordItems.length} keywords, ${commandItems.length} commands`);
console.log(`  ${blocks.length} folding blocks:`, blocks.map((b) => `${b.opener}..${b.closers.join('|')}`).join(', '));
console.log(
	'  top libraries:',
	Object.entries(byLibrary)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6),
);
for (const want of ['messagerequester', 'addelement', 'redim', 'foreach', 'endprocedure']) {
	const found = items.filter((i) => i.lower === want);
	console.log(
		`  check ${want.padEnd(18)} ->`,
		found.map((f) => `${f.name}[${f.kind}] ${f.signatures?.[0]?.label ?? ''}`).join(' | ') || 'MISSING',
	);
}
