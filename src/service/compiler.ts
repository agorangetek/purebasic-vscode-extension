/*
 * Turning the compiler settings into a pbcompiler command line.
 *
 * The settings mirror the PureBasic IDE's own Compiler Options dialog, read off
 * `PureBasicIDE/dialogs/CompilerOptions.xml` and its `[Compiler]` catalogue, and
 * The switches are per platform, the way the compiler is: the Unix build takes
 * `-d -cl -o`, the Windows one `/DEBUGGER /CONSOLE /EXE`.  Where the IDE and the
 * compiler disagree the compiler wins, since it is the one being invoked:
 * `-dl` takes the output path as its own argument rather than reading `-o`, and
 * `Debug` statements are compiled out entirely unless `-d` is passed.
 *
 * Editor-agnostic: no 'vscode' import, so the mapping can be checked with plain
 * node.
 */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

/** The IDE's Compiler Options, as far as the compiler implements them. */
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
	/** `windowed` is the IDE's plain application; `library` is its Shared dll. */
	executableFormat: 'windowed' | 'console' | 'library';
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
export function temporaryOutputFor(sourcePath: string, platform: Platform = hostPlatform()): string {
	const name = basename(sourcePath).replace(/\.[^.]*$/, '');
	const stamp = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
	const suffix = platform === 'win32' ? '.exe' : '';
	return join(tmpdir(), 'purebasic', `${name}-${stamp}${suffix}`);
}

/** The three platforms the compiler integration knows about. */
export type Platform = 'darwin' | 'linux' | 'win32';

/** The platform this is running on. */
export function hostPlatform(): Platform {
	return process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
}

/**
 * The compiler to run.
 *
 * Each platform keeps it somewhere different -- macOS inside the application
 * bundle, Linux and Windows inside the folder PureBasic came in -- and any of
 * them may also be on the PATH.  The installed one wins, because it is the one
 * that matches the PureBasic being used.
 */
export function resolveCompiler(configured: string, platform: Platform = hostPlatform()): string {
	const path = configured.trim();
	if (path) return path;

	for (const candidate of compilerCandidates(platform)) {
		if (existsSync(candidate)) return candidate;
	}
	return platform === 'win32' ? 'pbcompiler.exe' : 'pbcompiler';
}

/** Where a compiler is looked for before the PATH, best guess first. */
export function compilerCandidates(platform: Platform): string[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
	if (platform === 'darwin') {
		return [
			'/Applications/PureBasic.app/Contents/Resources/compilers/pbcompiler',
			join(home, 'Applications/PureBasic.app/Contents/Resources/compilers/pbcompiler'),
		];
	}
	if (platform === 'win32') {
		return [
			'C:\\Program Files\\PureBasic\\Compilers\\pbcompiler.exe',
			'C:\\Program Files (x86)\\PureBasic\\Compilers\\pbcompiler.exe',
		];
	}
	// a Linux install is a folder the reader unpacks, so the usual places first
	return [
		join(home, 'purebasic/compilers/pbcompiler'),
		'/opt/purebasic/compilers/pbcompiler',
		'/usr/local/purebasic/compilers/pbcompiler',
		'/usr/share/purebasic/compilers/pbcompiler',
		'/usr/lib/purebasic/compilers/pbcompiler',
	];
}

/*
 * The compiler's arguments, without the source file.
 *
 * The Unix build takes single-dash switches and the Windows one the same names
 * with a slash and no abbreviation (`/DEBUGGER`, not `-d`).  Both sets come from
 * the compiler's own help and from the IDE, which exposes them in its Compiler
 * Options dialog.
 */
export function compilerArguments(
	settings: CompilerSettings,
	outputPath?: string,
	platform: Platform = hostPlatform(),
): string[] {
	const flag = (unix: string, win: string) => (platform === 'win32' ? win : unix);
	const args: string[] = [];

	if (settings.debugger) args.push(flag('-d', '/DEBUGGER'));
	if (settings.threadsafe) args.push(flag('-t', '/THREAD'));
	if (settings.optimizer) args.push(flag('-z', '/OPTIMIZER'));
	if (settings.purifier) args.push(flag('-pf', '/PURIFIER'));
	if (settings.onErrorLines) args.push(flag('-l', '/ONERROR'));
	if (settings.quiet) args.push(flag('-q', '/QUIET'));
	if (settings.subsystem.trim()) args.push(flag('-s', '/SUBSYSTEM'), settings.subsystem.trim());

	if (outputPath) {
		// the library switch names the library itself; it does not read -o
		if (settings.executableFormat === 'library') {
			args.push(flag('-dl', '/DLL'), outputPath);
		} else {
			if (settings.executableFormat === 'console') args.push(flag('-cl', '/CONSOLE'));
			args.push(flag('-o', '/EXE'), outputPath);
		}
	}
	return args;
}

/** Where Compile writes: the setting, or the source's own name beside it. */
export function outputPathFor(
	sourcePath: string,
	settings: CompilerSettings,
	platform: Platform = hostPlatform(),
): string {
	const configured = settings.outputPath.trim();
	if (configured) return configured;

	const base = basename(sourcePath).replace(/\.[^.]*$/, '');
	const suffix =
		settings.executableFormat !== 'library'
			? platform === 'win32'
				? '.exe'
				: ''
			: platform === 'win32'
				? '.dll'
				: platform === 'darwin'
					? '.dylib'
					: '.so';
	return join(dirname(sourcePath), base + suffix);
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

/** One command line, quoted for the shell the terminal runs. */
export function shellCommand(parts: readonly string[], platform: Platform = hostPlatform()): string {
	return parts.map((part) => shellQuote(part, platform)).join(' ');
}

/**
 * One argument, quoted for the shell the terminal runs.
 *
 * POSIX shells want single quotes (with `'\''` for an embedded one); cmd and
 * PowerShell want double quotes, and both read `""` inside them as one quote.
 */
export function shellQuote(part: string, platform: Platform = hostPlatform()): string {
	if (part.length > 0 && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(part)) return part;
	if (platform === 'win32') return `"${part.replace(/"/g, '""')}"`;
	return `'${part.replace(/'/g, `'\\''`)}'`;
}

/** A program on the PATH, or undefined.  Used to find a terminal to open. */
function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (dir === '') continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The terminal the IDE itself looks for on Linux, in its order and with its
 * arguments: `-- ` for gnome-terminal, ` -e ` for the rest.
 */
function linuxTerminal(): { command: string; args: string[] } | undefined {
	for (const [name, args] of [
		['gnome-terminal', ['--']],
		['konsole', ['-e']],
		['aterm', ['-e']],
		['mlterm', ['-e']],
		['rxvt', ['-e']],
		['xterm', ['-e']],
		['lxterminal', ['-e']],
		['x-terminal-emulator', ['-e']],
	] as const) {
		const found = findOnPath(name);
		if (found) return { command: found, args: [...args] };
	}
	return undefined;
}

/**
 * A script that runs the program and lets its output be read.
 *
 * A terminal window closes when its shell exits, so a program that ran and
 * finished would take its output with it.  The script reports the exit status
 * and hands the window to an interactive shell, the way the PureBasic IDE
 * leaves one behind.  macOS opens a `.command` in Terminal; Linux runs a `.sh`
 * in whichever terminal it found; Windows needs no script, because `cmd /k`
 * keeps its own window open.
 */
export function writeLaunchScript(
	target: string,
	args: readonly string[],
	cwd: string,
	platform: Platform = hostPlatform(),
): string | undefined {
	if (platform === 'win32') return undefined;

	const lines = [
		'#!/bin/sh',
		`# PureBasic: written by the extension so the program gets a window of its own`,
		`cd ${shellQuote(cwd, platform)}`,
		shellCommand([target, ...args], platform),
		'status=$?',
		`printf '\\n[PureBasic] the program exited with %s\\n' "$status"`,
		'exec "${SHELL:-/bin/sh}" -i',
		'',
	];
	const extension = platform === 'darwin' ? 'command' : 'sh';
	const path = join(tmpdir(), `purebasic-run-${process.pid}-${Date.now()}.${extension}`);
	writeFileSync(path, lines.join('\n'), { mode: 0o755 });
	return path;
}

/**
 * The command, for the editor's terminal to run, that starts the program in a
 * window of its own -- or undefined when this platform has none to offer, in
 * which case the caller runs the program in the terminal it already has.
 */
export function launcherCommand(
	script: string | undefined,
	platform: Platform = hostPlatform(),
): string | undefined {
	if (platform === 'darwin') {
		return script ? shellCommand(['open', '-a', 'Terminal', script], platform) : undefined;
	}
	if (platform === 'linux') {
		const terminal = linuxTerminal();
		return terminal && script
			? shellCommand([terminal.command, ...terminal.args, script], platform)
			: undefined;
	}
	return undefined;
}

/** `cmd /c start` opens a console window; `/k` is what keeps it open. */
export function windowsLauncher(target: string, args: readonly string[], cwd: string): string {
	const inner = shellCommand([target, ...args], 'win32');
	return `cmd /c start "" /D ${shellQuote(cwd, 'win32')} cmd /k ${inner}`;
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
