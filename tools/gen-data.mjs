#!/usr/bin/env node
/*
 * Generates src/data/pb-builtins.json for the PureBasic extension.
 *
 * Two sources, both from the PureBasic IDE checkout that sits next to this
 * repository (pass its path, or set PB_IDE):
 *
 *   scripts/commands/pb_commands_full.json   every library command, with the
 *                                            manual's signature and its library
 *   scripts/PureBasicKeywords.gd             the reserved words, their canonical
 *                                            spelling, the code-folding pairs and
 *                                            the built-in type suffixes
 *
 * Commands keep the manual's own spelling (`MessageRequester`, `ReDim`), which
 * is the canonical case for PureBasic, and every command's signature is taken
 * apart into a call label and a parameter list so completion and signature help
 * have something to show.  The generated JSON is committed, so building the
 * extension does not need a PureBasic checkout; re-run this only to refresh it.
 *
 * Usage:
 *   node tools/gen-data.mjs ["/path/to/PB IDE"]
 *   PB_IDE="/path/to/PB IDE" node tools/gen-data.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const pbIde = process.argv[2] || process.env.PB_IDE || join(root, '..', 'PB IDE');
const commandsFile = join(pbIde, 'scripts', 'commands', 'pb_commands_full.json');
const namesFile = join(pbIde, 'scripts', 'commands', 'pb_commands.json');
const keywordsFile = join(pbIde, 'scripts', 'PureBasicKeywords.gd');

/* ------------------------------------------------------------------ helpers */

/**
 * Split a manual parameter list on its commas.
 *
 * The manual marks optional parameters with brackets, and nests them:
 * "Title$, Text$ [, Flags [, ParentID]]".  A bracket is therefore not a
 * grouping -- the comma inside it is still a separator -- while parentheses
 * are (".f(.d)", "List()").  A '[' makes every parameter after the next comma
 * optional, which is how "Title$" and "Text$" stay required and "Flags" and
 * "ParentID" do not.
 */
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

/**
 * One parameter as the manual writes it:
 *   "Title.s"        -> { name: "Title",        type: "s" }
 *   "*Input"         -> { name: "*Input",       type: "" }
 *   "Flags.i"        -> { name: "Flags",        type: "i", mode: "optional" }
 *   "Flags.i = 0"    -> { name: "Flags",        type: "i = 0" }
 */
function parseParam(raw) {
	let text = raw.text.trim();
	const mode = raw.optional ? 'optional' : '';

	// a default value belongs to the parameter, not to the type
	let type = '';
	const eq = text.search(/\s=\s/);
	let body = text;
	if (eq > 0) {
		type = text.slice(eq).trim();
		body = text.slice(0, eq).trim();
	}

	// an explicit ".suffix" / ".StructName" / ".s{10}"
	const dot = body.match(/^(.*?)(?:\.([A-Za-z_][A-Za-z0-9_-]*(?:\{[^}]*\})?))$/);
	let name = body;
	if (dot) {
		name = dot[1].trim();
		type = [dot[2], type].filter(Boolean).join(' ');
	}

	// a lone type with no name ("Result.f") is not a parameter
	name = name.replace(/[,\s]+$/, '').trim();
	if (!/^[*@?]?[A-Za-z_#][A-Za-z0-9_]*\$?$/.test(name)) return undefined;
	return { mode, name, type };
}

/** "Result.f(.d) = Abs(Number.f(.d))" -> the call, its label and its parameters. */
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

/** Pull a plain GDScript string array out of the keyword table. */
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

/* ----------------------------------------------------------------- commands */

const commandItems = [];
const seenCommand = new Set();
for (const command of commands) {
	const lower = String(command.name).toLowerCase();
	// a few commands are listed under more than one library (AddPathLine joins
	// both the 2D and the 3D drawing set): keep the first entry only, so every
	// name has one id and one completion entry
	if (seenCommand.has(lower)) continue;
	seenCommand.add(lower);
	const name = canonicalNames.find((n) => n.toLowerCase() === lower) ?? command.name;
	const text = String(command.signature ?? name);
	const signature = parseSignature(text, name);
	// "Result.f(.d) = Abs(...)" returns a value; a bare "AbortFTPFile(#Ftp)" does not
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

/* ------------------------------------------------------------------- blocks */

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

// commands first: a few names are both a keyword and a library command
// (AddElement, ClearList, ...) and the command entry carries the signature
const items = [...commandItems, ...keywordItems];

const out = {
	source: `PureBasic ${commandItems.length} library commands and ${keywordItems.length} keywords`,
	generatedFrom: pbIde,
	count: items.length,
	/** Canonical spelling of every reserved word, lower case keyed. */
	keywords: [...canonical.values()],
	keywordCanonical: Object.fromEntries(canonical),
	typeSuffixes,
	blocks,
	items,
};

/* ------------------------------------------------------------------- output */

mkdirSync(join(root, 'src', 'data'), { recursive: true });
const outFile = join(root, 'src', 'data', 'pb-builtins.json');
writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');

const tsFile = join(root, 'src', 'data', 'pb-builtins.ts');

/*
 * The item list runs to a couple of thousand entries.  Emitted as one literal,
 * TypeScript gives up on the inferred type ("expression produces a union type
 * that is too complex to represent"), so it is written in chunks and spread
 * back together -- each chunk stays small enough to check.
 */
const CHUNK = 250;
const chunks = [];
for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));

const meta = { ...out };
delete meta.items;

const lines = [
	'/* Generated by tools/gen-data.mjs -- do not edit by hand.',
	` * Source: ${out.source}`,
	' * Regenerate with: npm run gen-data',
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
writeFileSync(tsFile, lines.join('\n'));

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
