/*
 * Reading what the command-line debugger prints.
 *
 * Every shape below is taken from real transcripts of the debugger (PureBasic
 * 6.41, macOS), which is why the parsers are as literal as they are:
 *
 *   [Included Source files]
 *     0 - main.pb
 *
 *   File: inc.pb
 *   Line: 3
 *
 *   [Debugger Line Breakpoints]
 *     #1  Line: 20	File: 0	(full.pb)
 *
 *   [Debugger Variable Dump]
 *
 *   Main source variables:
 *      Global  String  gname                          "global"
 *      Global Integer  gcount                         1
 *        Main Integer  total                          0
 *
 *   Variables in Procedure: Work()
 *       Local Integer  a                              3
 *       Local  Struct  p.Point
 *                Quad     \x                3
 *
 *   [Debugger Array Display]
 *     garray(0) = 7
 *
 *   [Debugger Error]  Pointer is null.
 *   [Debugger Error]  File: boom.pb (Line: 4)
 *
 * Editor-agnostic: no 'vscode' import, so the formats can be checked against
 * those transcripts with plain node.
 */

/** A source file, under the number the debugger refers to it by. */
export interface DebugFile {
	number: number;
	name: string;
}

/** A place in the source: the debugger names the file without its directory. */
export interface DebugLocation {
	file: string;
	line: number;
}

export interface DebugBreakpoint {
	id: number;
	line: number;
	file: number;
}

/** One variable, as the dump describes it. */
export interface DebugVariable {
	name: string;
	type: string;
	/** As printed: numbers plain, strings quoted, structures empty. */
	value: string;
	children: DebugVariable[];
	/** Set for the ones whose contents are asked for rather than printed. */
	container: '' | 'array' | 'list' | 'map';
}

/** A group of variables: the main source, or one procedure's locals. */
export interface DebugScope {
	name: string;
	procedure: string;
	variables: DebugVariable[];
}

/** A frame of the procedure history. */
export interface DebugFrame {
	procedure: string;
	file: string;
	line: number;
}

/** A runtime error the debugger reported. */
export interface DebugError {
	message: string;
	file: string;
	line: number;
}

/** The words the dump uses for where a variable lives. */
const SCOPES = new Set(['global', 'main', 'local', 'shared', 'static', 'threaded']);

/** The words it uses for what a variable is, when it holds more than a value. */
const CONTAINERS = new Map<string, DebugVariable['container']>([
	['array', 'array'],
	['list', 'list'],
	['linkedlist', 'list'],
	['map', 'map'],
]);

/** The text as lines, without the carriage returns a terminal adds. */
export function lines(text: string): string[] {
	return text.replace(/\r/g, '').split('\n');
}

/**
 * The body of a `[Debugger ...]` section.
 *
 * A section ends at the blank line the debugger prints after one, at the next
 * header, or at the prompt -- the debugger is not consistent about the blank
 * line, and some of what it prints has none.
 */
export function section(text: string, header: string): string[] {
	const all = lines(text);
	const start = all.findIndex((line) => line.trim().startsWith(header));
	if (start === -1) return [];

	const body: string[] = [];
	for (const line of all.slice(start + 1)) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('[') || trimmed.startsWith('DEBUGGER::')) break;
		body.push(line);
	}
	return body;
}

/** The files the debugger knows, main file first. */
export function parseFiles(text: string): DebugFile[] {
	const files: DebugFile[] = [];
	for (const line of section(text, '[Included Source files]')) {
		const match = /^\s*(\d+)\s+-\s+(.+?)\s*$/.exec(line);
		if (match) files.push({ number: Number(match[1]), name: match[2]! });
	}
	return files;
}

/** Where `line` says the program is. */
export function parseLocation(text: string): DebugLocation | undefined {
	const plain = text.replace(/\r/g, '');
	const file = /^File:\s*(.+?)\s*$/m.exec(plain)?.[1];
	const line = /^Line:\s*(\d+)\s*$/m.exec(plain)?.[1];
	return file !== undefined && line !== undefined ? { file, line: Number(line) } : undefined;
}

/** The breakpoints the debugger is holding. */
export function parseBreakpoints(text: string): DebugBreakpoint[] {
	const found: DebugBreakpoint[] = [];
	for (const line of section(text, '[Debugger Line Breakpoints]')) {
		const match = /#(\d+)\s+Line:\s*(\d+)\s+File:\s*(\d+)/.exec(line);
		if (match) found.push({ id: Number(match[1]), line: Number(match[2]), file: Number(match[3]) });
	}
	return found;
}

/** The number of the breakpoint just set, from `Breakpoint #1 set on line: 20`. */
export function parseBreakpointSet(text: string): number | undefined {
	const match = /Breakpoint #(\d+) set on line/.exec(text);
	return match ? Number(match[1]) : undefined;
}

/** The variables the dump describes, in the groups it prints them in. */
export function parseVariables(text: string): DebugScope[] {
	const scopes: DebugScope[] = [];
	let scope: DebugScope | undefined;

	/** The variables a more indented line could belong to, outermost first. */
	const stack: { variable: DebugVariable; indent: number }[] = [];

	for (const line of lines(text)) {
		if (/^Main source variables:\s*$/.test(line)) {
			scope = { name: 'Main', procedure: '', variables: [] };
			scopes.push(scope);
			stack.length = 0;
			continue;
		}
		const procedure = /^Variables in Procedure:\s*(.+?)\(\)\s*$/.exec(line);
		if (procedure) {
			scope = { name: 'Local', procedure: procedure[1]!, variables: [] };
			scopes.push(scope);
			stack.length = 0;
			continue;
		}
		if (!scope || line.trim() === '') continue;

		const parsed = parseVariable(line);
		if (!parsed) continue;

		while (stack.length > 0 && parsed.indent <= stack[stack.length - 1]!.indent) stack.pop();
		if (parsed.scope === '' && stack.length > 0) {
			stack[stack.length - 1]!.variable.children.push(parsed.variable);
		} else {
			scope.variables.push(parsed.variable);
			stack.length = 0;
		}
		stack.push({ variable: parsed.variable, indent: parsed.indent });
	}
	return scopes;
}

/** One line of the dump, with the scope word split off when it has one. */
function parseVariable(
	line: string,
): { scope: string; indent: number; variable: DebugVariable } | undefined {
	const indent = line.length - line.trimStart().length;
	let rest = line.trim();

	let scope = '';
	const first = /^([A-Za-z]+)\s+/.exec(rest);
	if (first && SCOPES.has(first[1]!.toLowerCase())) {
		scope = first[1]!;
		rest = rest.slice(first[0].length);
	}

	// the type and the name sit in columns of their own, two spaces apart
	const columns = rest.split(/\s{2,}/);
	const type = (columns[0] ?? '').trim();
	const name = columns[1];
	if (!type || !name || !/^[*@]?[A-Za-z_\\]/.test(name)) return undefined;

	// whatever follows the name is the value, spacing and all -- and the name
	// is looked for after the type, since a variable called `a` also occurs in
	// `Local` and a variable called `p` in `Protected`
	const typeAt = line.indexOf(type, indent);
	const nameAt = line.indexOf(name, typeAt + type.length);
	const value = columns.length > 2 ? line.slice(nameAt + name.length).trim() : '';
	const container = CONTAINERS.get(type.toLowerCase()) ?? '';

	return { scope, indent, variable: { name, type, value, children: [], container } };
}

/**
 * The arrays, lists and maps the debugger names in its `arrays`, `linkedlists`
 * and `maps` listings.  They are variables like the rest, but their contents are
 * asked for rather than printed, so they are marked as containers.
 */
export function parseContainers(text: string): DebugVariable[] {
	const containers: DebugVariable[] = [];
	const listings: [string, DebugVariable['container']][] = [
		['[Debugger Array List]', 'array'],
		['[Debugger LinkedList List]', 'list'],
		['[Debugger Map List]', 'map'],
	];

	for (const [header, kind] of listings) {
		for (const line of section(text, header)) {
			// the listing is aligned with single spaces, unlike the variable dump:
			//     Global Integer garray(5)
			//     Global Integer  glist()   - elements: 2 current: 1
			const match = /^\s*(?:([A-Za-z]+)\s+)?([A-Za-z]+)\s+(\S+?)(?:\s+-\s+(.*))?$/.exec(line);
			if (!match) continue;
			const scope = match[1] ?? '';
			if (scope !== '' && !SCOPES.has(scope.toLowerCase())) continue;
			containers.push({
				name: match[3]!,
				type: match[2]!,
				value: match[4] ? `- ${match[4]}` : '',
				children: [],
				container: kind,
			});
		}
	}
	return containers;
}

/** What `show <name>()` printed: the entries, or why there are none. */
export interface ShownContents {
	kind: DebugVariable['container'];
	entries: { name: string; value: string }[];
	error: string;
}

export function parseShow(text: string): ShownContents {
	const kinds: [string, DebugVariable['container']][] = [
		['[Debugger Array Display]', 'array'],
		['[Debugger LinkedList Display]', 'list'],
		['[Debugger Map Display]', 'map'],
	];

	for (const [header, kind] of kinds) {
		if (!lines(text).some((line) => line.trim() === header)) continue;

		const entries: { name: string; value: string }[] = [];
		for (const line of section(text, header)) {
			// garray(0) = 7 | 1: glist() = 22 | gmap("two")	= 2
			const match = /^\s*(.+?)\s*=\s*(.*?)\s*$/.exec(line);
			if (match) entries.push({ name: match[1]!.replace(/^\d+:\s*/, ''), value: match[2]! });
		}
		return { kind, entries, error: '' };
	}

	const failure = lines(text)
		.map((line) => line.trim())
		.find((line) => line.startsWith('Error:'));
	return { kind: '', entries: [], error: failure ? failure.slice('Error:'.length).trim() : '' };
}

/** The procedure history: which line called into which procedure. */
export function parseFrames(text: string): DebugFrame[] {
	const frames: DebugFrame[] = [];
	for (const line of section(text, '[Debugger Procedure History]')) {
		const call = /^On Line\s+(\d+)\s+\((.+?)\)\s+called:\s*$/.exec(line.trim());
		if (call) {
			frames.push({ procedure: '', file: call[2]!, line: Number(call[1]) });
			continue;
		}
		const called = /^-->\s*([A-Za-z_]\w*)\s*\(/.exec(line.trim());
		const frame = frames[frames.length - 1];
		if (called && frame) frame.procedure = called[1]!;
	}
	return frames;
}

/** The runtime errors in the debugger's output, with where they happened. */
export function parseErrors(text: string): DebugError[] {
	const found: DebugError[] = [];

	for (const line of lines(text)) {
		const place = /^\[Debugger Error\]\s+File:\s*(.+?)\s+\(Line:\s*(\d+)\)\s*$/.exec(line.trim());
		if (place) {
			// the debugger names the place on the line *after* the message it
			// belongs to, so it goes to the message still waiting for one
			const last = found[found.length - 1];
			if (last && last.file === '') {
				last.file = place[1]!;
				last.line = Number(place[2]);
			}
			continue;
		}
		const message = /^\[Debugger Error\]\s+(.+?)\s*$/.exec(line.trim());
		if (message) found.push({ message: message[1]!, file: '', line: 0 });
	}
	return found;
}

/**
 * What the program itself printed, as opposed to what the debugger had to say.
 *
 * `Debug` output arrives with the debugger's own prefix, which is taken off: it
 * is the program's output, and belongs in the debug console with the rest of it.
 * A line that starts at the left margin with no marker is a console program's
 * own writing; everything indented, bracketed or blank is the console talking.
 */
export function parseProgramOutput(text: string): { stream: 'stdout' | 'stderr'; text: string }[] {
	const printed: { stream: 'stdout' | 'stderr'; text: string }[] = [];
	for (const line of lines(text)) {
		const debug = /^\[Debugger\]\s\s(.*)$/.exec(line);
		if (debug) {
			printed.push({ stream: 'stdout', text: `${debug[1]!}\n` });
			continue;
		}
		const error = /^\[(?:Debugger|PureBasic Debugger) Error\]\s\s?(.*)$/.exec(line);
		if (error) {
			printed.push({ stream: 'stderr', text: `${error[1]!}\n` });
			continue;
		}
		if (line === '' || /^\s/.test(line) || line.startsWith('[') || line.startsWith('DEBUGGER::')) continue;
		printed.push({ stream: 'stdout', text: `${line}\n` });
	}
	return printed;
}
