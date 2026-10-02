#!/usr/bin/env node
/*
 * Generates src/data/pb-constants.json for the PureBasic extension.
 *
 * PureBasic's built-in constants come from two places, and neither of the
 * tables tools/gen-data.mjs is generated from knows any of them:
 *
 *   reference/pbconstants.html   the manual's "Overview about PureBasic
 *                                Constants": every constant a library defines,
 *                                with the commands that use it.  It ships with
 *                                the installation, in the help folder.
 *   the compiler itself          a handful of language constants -- the
 *                                booleans, #Null, #PI/#E and the character
 *                                codes -- which the manual does not put in
 *                                that table.  They are written down below.
 *
 * The page has one <tr> per constant: its name in the first cell, then a list
 * of links to the commands that use it.  Only the links are kept, as the
 * commands' names; the folder they live in is a command's library, not the
 * constant's, and a constant shared by commands of several libraries (every
 * `#PB_Any`) has no one library to name.
 *
 * Usage:
 *   node tools/gen-constants.mjs ["/path/to/help/purebasic"]
 *   PB_HELP="/path/to/help/purebasic" node tools/gen-constants.mjs
 *
 * Without either it looks where a PureBasic installation keeps the folder:
 * inside the application bundle on macOS, and beside the compiler on Linux.  A
 * Windows installation ships its help as a .chm, so there PB_HELP has to point
 * at a copy of the extracted HTML.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* -------------------------------------------------------------------- input */

/** The folders a PureBasic help tree is looked for in, best guess first. */
function helpFolders() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
	return [
		'/Applications/PureBasic.app/Contents/Resources/help/purebasic',
		join(home, 'Applications/PureBasic.app/Contents/Resources/help/purebasic'),
		join(home, 'purebasic/help/purebasic'),
		join(home, 'purebasic/Help'),
		'/opt/purebasic/help/purebasic',
		'/usr/local/purebasic/help/purebasic',
		'/usr/share/purebasic/help/purebasic',
		'/usr/lib/purebasic/help/purebasic',
	];
}

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const configured = args[0] || process.env.PB_HELP || '';

/** The folder holding reference/pbconstants.html, or '' when none was found. */
function findHelpFolder() {
	if (configured) return configured;
	for (const folder of helpFolders()) {
		if (existsSync(join(folder, 'reference', 'pbconstants.html'))) return folder;
	}
	return '';
}

const helpFolder = findHelpFolder();
const constantsFile = helpFolder ? join(helpFolder, 'reference', 'pbconstants.html') : '';

/*
 * The language's own constants.
 *
 * The manual leaves these out of pbconstants.html -- they belong to the
 * language rather than to a library -- and the compiler keeps them in a binary
 * table nothing can read.  They are written down here instead, and every one of
 * them was checked against pbcompiler 6.50 beta 1 by using it where a constant
 * is required (`Dim arr(#Name)`), which is the only way that compiler reports
 * an undefined constant.  The spellings an older manual names and a later
 * compiler dropped -- `#DQ$`, `#EOL$` -- and `#NUL$`, which a PureBasic string
 * cannot hold, are not here.
 *
 * The character constants are the ASCII control codes, which is why the table
 * below carries their number: the description is generated from it.
 */
const LANGUAGE_CONSTANTS = [
	['#True', 'The boolean true value, 1.'],
	['#False', 'The boolean false value, 0.'],
	['#Null', 'The null pointer value, 0.'],
	['#Null$', 'The null string, for an API call that wants one.'],
	['#Empty$', 'The empty string.'],
	['#CRLF$', 'A carriage return and a line feed, the line ending a Windows text file uses.'],
	['#PI', "Pi: the ratio of a circle's circumference to its diameter."],
	['#E', "Euler's number, the base of the natural logarithm."],
	['#DOUBLEQUOTE$', 'A double quote, the one character a plain string cannot hold.'],
];

/** The ASCII control codes PureBasic defines as `#NAME$` string constants. */
const CHARACTER_CONSTANTS = [
	['SOH', 1, 'start of heading'],
	['STX', 2, 'start of text'],
	['ETX', 3, 'end of text'],
	['EOT', 4, 'end of transmission'],
	['ENQ', 5, 'enquiry'],
	['ACK', 6, 'acknowledge'],
	['BEL', 7, 'bell'],
	['BS', 8, 'backspace'],
	['HT', 9, 'horizontal tab'],
	['TAB', 9, 'tab'],
	['LF', 10, 'line feed'],
	['VT', 11, 'vertical tab'],
	['FF', 12, 'form feed'],
	['CR', 13, 'carriage return'],
	['SO', 14, 'shift out'],
	['SI', 15, 'shift in'],
	['DLE', 16, 'data link escape'],
	['DC1', 17, 'device control 1'],
	['DC2', 18, 'device control 2'],
	['DC3', 19, 'device control 3'],
	['DC4', 20, 'device control 4'],
	['NAK', 21, 'negative acknowledge'],
	['SYN', 22, 'synchronous idle'],
	['ETB', 23, 'end of transmission block'],
	['CAN', 24, 'cancel'],
	['EM', 25, 'end of medium'],
	['SUB', 26, 'substitute'],
	['ESC', 27, 'escape'],
	['FS', 28, 'file separator'],
	['GS', 29, 'group separator'],
	['RS', 30, 'record separator'],
	['US', 31, 'unit separator'],
	['DEL', 127, 'delete'],
];

/* ------------------------------------------------------------------ parsing */

/**
 * One constant per `<tr>`: the name in the first cell, then the links to the
 * commands that use it.  The header row has no `#Name` in it and is dropped.
 */
function parseConstants(html) {
	const items = [];
	const seen = new Set();
	for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
		const name = /<font color="#924B72" size=-1>([^<]+)<\/font>/.exec(row[1])?.[1]?.trim();
		if (!name || !/^#[A-Za-z_]\w*\$?$/.test(name)) continue;
		if (seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());

		const commands = [];
		for (const link of row[1].matchAll(/<a href=[^>]*>([^<]+)<\/a>/g)) {
			const label = link[1].trim();
			if (label && !commands.includes(label)) commands.push(label);
		}
		items.push({ name, commands });
	}
	return items;
}

/* ------------------------------------------------------------------- output */

const tableItems = helpFolder ? parseConstants(readFileSync(constantsFile, 'utf8')) : [];
if (tableItems.length === 0) {
	console.error('could not read the PureBasic constant table');
	console.error(helpFolder ? `  looked at ${constantsFile}` : '  no help folder found');
	console.error('pass the path to a help/purebasic folder, or set PB_HELP');
	process.exit(1);
}

const languageItems = [
	...LANGUAGE_CONSTANTS.map(([name, doc]) => ({ name, commands: [], doc })),
	...CHARACTER_CONSTANTS.map(([code, value, meaning]) => ({
		name: `#${code}$`,
		commands: [],
		doc: `The ${meaning} character (ASCII ${value}).`,
	})),
];

// a language constant the table happens to carry as well keeps the table's entry
const tableNames = new Set(tableItems.map((item) => item.name.toLowerCase()));
const items = [...tableItems, ...languageItems.filter((item) => !tableNames.has(item.name.toLowerCase()))];
// the table is alphabetical and the language constants are appended, so the
// list has to be sorted as a whole to stay in one order; a plain code-unit
// compare keeps that order the same on every machine
items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const out = {
	source:
		`PureBasic ${tableItems.length} constants from the manual's overview ` +
		`and ${items.length - tableItems.length} language constants`,
	count: items.length,
	items,
};

const outFile = join(root, 'src', 'data', 'pb-constants.json');
const jsonText = JSON.stringify(out, null, 1) + '\n';

if (process.argv.includes('--check')) {
	if (!existsSync(outFile) || readFileSync(outFile, 'utf8') !== jsonText) {
		console.error(`stale: ${outFile} is not what the installed help describes`);
		process.exit(1);
	}
	console.log(`up to date: ${outFile}`);
	process.exit(0);
}

writeFileSync(outFile, jsonText);
console.log(`wrote ${outFile}`);
console.log(`  ${tableItems.length} table constants, ${items.length - tableItems.length} language constants`);
