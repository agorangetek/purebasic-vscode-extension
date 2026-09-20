/*
 * Turning the compiler settings into a pbcompiler command line.
 *
 * The settings mirror the PureBasic IDE's own Compiler Options dialog, read off
 * `PureBasicIDE/dialogs/CompilerOptions.xml` and its `[Compiler]` catalogue, and
 * the switches are the ones `pbcompiler -h` documents.  Where the IDE and the
 * compiler disagree the compiler wins, since it is the one being invoked:
 * `-dl` takes the output path as its own argument rather than reading `-o`, and
 * `Debug` statements are compiled out entirely unless `-d` is passed.
 *
 * Editor-agnostic: no 'vscode' import, so the mapping can be checked with plain
 * node.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The IDE's Compiler Options, as far as the macOS/Linux compiler implements them. */
/*
 * The defaults are declared in package.json, where the settings editor shows
 * them and where VS Code applies them, and read back with the same fallbacks in
 * extension.ts.  There is deliberately no second copy here: a default in two
 * places is a default that drifts.
 */
export interface CompilerSettings {
	/** Empty: find the installed compiler, then fall back to PATH. */
	path: string;
	debugger: boolean;
	optimizer: boolean;
	threadsafe: boolean;
	purifier: boolean;
	onErrorLines: boolean;
	executableFormat: 'macos' | 'console' | 'dylib';
	subsystem: string;
	/** Where Compile writes.  Empty: beside the source. */
	outputPath: string;
	/** Arguments handed to the program when Run starts it. */
	commandLine: string;
	/** `-q`: only errors on stdout. */
	quiet: boolean;
}

/**
 * Where a Run builds its temporary executable.
 *
 * Named after the source and its directory, so two files called `test.pb` do not
 * overwrite each other and rebuilding one reuses the same path.
 */
export function temporaryOutputFor(sourcePath: string): string {
	const name = basename(sourcePath).replace(/\.[^.]*$/, '');
	const stamp = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
	return join(tmpdir(), 'purebasic', `${name}-${stamp}`);
}

/**
 * The compiler to run.  The IDE installs one inside the application bundle, and
 * a command on PATH is whatever the reader put there, so the bundle wins: it is
 * the one that matches the PureBasic they are running.
 */
export function resolveCompiler(configured: string): string {
	const path = configured.trim();
	if (path) return path;

	const bundle = '/Applications/PureBasic.app/Contents/Resources/compilers/pbcompiler';
	if (existsSync(bundle)) return bundle;

	return 'pbcompiler';
}

/**
 * The compiler's arguments, without the source file.
 *
 * Unix-style single-dash switches, which is what the macOS and Linux builds
 * document.  Windows spells these `/DEBUGGER`, `/CONSOLE` and so on, and is
 * deliberately not guessed at here.
 */
export function compilerArguments(settings: CompilerSettings, outputPath?: string): string[] {
	const args: string[] = [];
	if (settings.debugger) args.push('-d');
	if (settings.threadsafe) args.push('-t');
	if (settings.optimizer) args.push('-z');
	if (settings.purifier) args.push('-pf');
	if (settings.onErrorLines) args.push('-l');
	if (settings.quiet) args.push('-q');
	if (settings.subsystem.trim()) args.push('-s', settings.subsystem.trim());

	// `-dl` names the library itself; the other two formats take `-o`
	if (outputPath) {
		if (settings.executableFormat === 'dylib') {
			args.push('-dl', outputPath);
		} else {
			if (settings.executableFormat === 'console') args.push('-cl');
			args.push('-o', outputPath);
		}
	}
	return args;
}

/** Where Compile writes: the setting, or the source's own name beside it. */
export function outputPathFor(sourcePath: string, settings: CompilerSettings): string {
	const configured = settings.outputPath.trim();
	if (configured) return configured;
	const base = basename(sourcePath).replace(/\.[^.]*$/, '');
	if (settings.executableFormat === 'dylib') return join(dirname(sourcePath), `${base}.dylib`);
	return join(dirname(sourcePath), base);
}

/**
 * A command line split into arguments, for `purebasic.compiler.commandLine`.
 *
 * Split as a shell would: on whitespace, with single or double quotes grouping,
 * and no expansion of anything -- the arguments are handed to the program as
 * written.
 */
export function splitCommandLine(text: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quote: string | undefined;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (current) {
				parts.push(current);
				current = '';
			}
		} else {
			current += ch;
		}
	}
	if (current) parts.push(current);
	return parts;
}

/**
 * The exit code a build left in a file, or undefined if it never got there.
 *
 * A command sent to a terminal reports nothing back -- there is no exit event
 * for one -- so the build line writes `$?` to a file of its own and this waits
 * for it.  The shell is POSIX, which is what the compiler switches assume too;
 * it is also why this polls rather than watching, since the file does not exist
 * until the build ends.
 */
export async function waitForExitMarker(path: string, timeoutMs = 300_000): Promise<number | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = readFileSync(path, 'utf8').trim();
			if (text !== '') return Number.parseInt(text, 10);
		} catch {
			// not written yet
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return undefined;
}

/** One command line, quoted for the shell the terminal runs. */
export function shellCommand(parts: readonly string[]): string {
	return parts.map(quote).join(' ');
}

function quote(part: string): string {
	if (part.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(part)) return part;
	return `'${part.replace(/'/g, `'\\''`)}'`;
}

/** A source line the compiler rejected, from its `Error: Line N - message`. */
export interface CompilerError {
	line: number;
	message: string;
}

/**
 * The errors in the compiler's output.
 *
 * It writes them to stdout as `Error: Line 12 - <message>` (`Error` for a
 * failure, `Warning` for a warning), one per line, and exits non-zero.  Kept
 * here rather than only shown in the terminal so a caller can act on them.
 */
export function parseCompilerOutput(text: string): CompilerError[] {
	const errors: CompilerError[] = [];
	for (const line of text.split('\n')) {
		const match = /^\s*(?:Error|Warning)\s*:\s*Line\s+(\d+)\s*-\s*(.*)$/i.exec(line.trim());
		if (match) errors.push({ line: Number(match[1]), message: match[2]!.trim() });
	}
	return errors;
}
