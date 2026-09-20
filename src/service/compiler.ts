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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
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
	/** Where Compile writes.  Empty: beside the source.  A directory: in there. */
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
	return temporaryOutput(sourcePath, platform, '');
}

/**
 * Where Compile stages its build, before the save panel names the destination.
 *
 * A name of its own, so that compiling while a Run of the same file is still
 * open does not write the very executable that is running -- which Windows
 * would refuse, and which would leave that Run with a file it no longer owns.
 */
export function stagedOutputFor(sourcePath: string, platform: Platform = hostPlatform()): string {
	return temporaryOutput(sourcePath, platform, '-compile');
}

function temporaryOutput(sourcePath: string, platform: Platform, tag: string): string {
	const name = basename(sourcePath).replace(/\.[^.]*$/, '');
	const stamp = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
	const suffix = platform === 'win32' ? '.exe' : '';
	return join(tmpdir(), 'purebasic', `${name}${tag}-${stamp}${suffix}`);
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

/**
 * The extension Compile's output carries here, without the dot.
 *
 * Empty on the Unix platforms for an application, because that is what the
 * compiler itself does: the file keeps the name it was given.  It is the
 * library switch that always wants a suffix, and Windows that wants `.exe`.
 */
export function outputExtensionFor(
	settings: CompilerSettings,
	platform: Platform = hostPlatform(),
): string {
	if (settings.executableFormat === 'library') {
		if (platform === 'win32') return 'dll';
		return platform === 'darwin' ? 'dylib' : 'so';
	}
	return platform === 'win32' ? 'exe' : '';
}

/** What Compile calls the output when the source is all it has to go on. */
export function outputNameFor(
	sourcePath: string,
	settings: CompilerSettings,
	platform: Platform = hostPlatform(),
): string {
	const base = basename(sourcePath).replace(/\.[^.]*$/, '');
	const extension = outputExtensionFor(settings, platform);
	return extension ? `${base}.${extension}` : base;
}

/**
 * Where Compile writes, as the save panel should first offer it.
 *
 * Beside the source under the source's own name, unless `outputPath` says
 * otherwise -- and a setting that names a folder, whether it ends in a
 * separator or is simply there already, means the folder to write in, since the
 * compiler's `-o` wants a file and would only fail on a directory.
 */
export function outputPathFor(
	sourcePath: string,
	settings: CompilerSettings,
	platform: Platform = hostPlatform(),
): string {
	const configured = settings.outputPath.trim();
	if (!configured) return join(dirname(sourcePath), outputNameFor(sourcePath, settings, platform));
	if (isFolder(configured)) return join(configured, outputNameFor(sourcePath, settings, platform));
	return configured;
}

/**
 * What Compile should offer in the platform's own save panel.
 *
 * The panel is the system's, so what is offered has to be the platform's too:
 * the extension it puts on the output, and therefore the file type it can
 * filter on, is `.exe` on Windows, `.dylib` on macOS and `.so` on Linux, and an
 * application on the Unix systems has none at all -- which leaves the panel
 * unfiltered there, as it should be.
 */
export interface SavePanel {
	title: string;
	saveLabel: string;
	/** Where it opens, under the name the output would take. */
	path: string;
	filters?: Record<string, string[]>;
}

/** The save panel for a Compile of this source, on this platform. */
export function compileSavePanel(
	sourcePath: string,
	settings: CompilerSettings,
	platform: Platform = hostPlatform(),
): SavePanel {
	const extension = outputExtensionFor(settings, platform);
	const library = settings.executableFormat === 'library';
	return {
		title: library ? 'Compile to Library' : 'Compile to Executable',
		saveLabel: 'Compile',
		path: outputPathFor(sourcePath, settings, platform),
		...(extension
			? {
					filters: {
						[library ? (platform === 'win32' ? 'DLL' : 'Shared library') : 'Executable']: [extension],
					},
				}
			: {}),
	};
}

/** Whether a path is written as a folder, or is one that is already there. */
function isFolder(path: string): boolean {
	if (path.endsWith('/') || path.endsWith('\\')) return true;
	try {
		return statSync(path).isDirectory();
	} catch {
		// not there, or not readable: treat it as the file the user named
		return false;
	}
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

/** A source line the compiler rejected. */
export interface CompilerError {
	/** Empty when the line is in the file that was compiled. */
	file: string;
	line: number;
	message: string;
	severity: 'error' | 'warning';
}

/** What a finished build had to say, and how it ended. */
export interface BuildResult {
	/** The exit code, or -1 when the compiler could not be run at all. */
	code: number;
	output: string;
}

/**
 * Run the compiler, and wait for it.
 *
 * Compile has to know whether the build worked before it can ask where the
 * result should go, and a command typed into the terminal cannot tell it.  The
 * arguments go to the program directly rather than through a shell, so nothing
 * in a path has to survive quoting.
 */
export function runCompiler(
	compiler: string,
	args: readonly string[],
	cwd: string,
): Promise<BuildResult> {
	return new Promise((resolve) => {
		const child = spawn(compiler, [...args], { cwd });
		let output = '';
		const collect = (chunk: Buffer) => {
			output += chunk.toString();
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.on('error', (error) => {
			resolve({ code: -1, output: `${output}${String(error.message)}\n` });
		});
		child.on('close', (code) => {
			resolve({ code: code === null ? -1 : code, output });
		});
	});
}

/**
 * Put a staged build at the path that was chosen for it.
 *
 * A plain rename is what a build beside its source amounts to.  Across volumes
 * -- a temporary directory on another disk than the destination -- the rename
 * cannot work, so the file is copied and the copy is given the mode of the
 * original, which is what makes an executable executable.
 */
export function placeBuiltFile(staged: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true });
	if (staged === destination) return;
	try {
		renameSync(staged, destination);
	} catch {
		copyFileSync(staged, destination);
		chmodSync(destination, statSync(staged).mode & 0o777);
		unlinkSync(staged);
	}
}

/**
 * The errors in the compiler's output.
 *
 * It writes them to stdout and exits non-zero, in one of two shapes.  A line of
 * the compiled file is named outright, as
 * `Error: Line 12 - <message>` (`Warning` in place of `Error` for a warning);
 * a line of an included file is named in two, as
 * `Error: in included file '<path>'` and then the `Line 12 - <message>` that
 * belongs to it.  Kept here rather than only shown in the terminal so a caller
 * can act on them, which is what puts them under the line in the editor.
 */
export function parseCompilerOutput(text: string): CompilerError[] {
	const errors: CompilerError[] = [];
	/** The included file a following `Line N - ...` belongs to, if any. */
	let file = '';
	let severity: CompilerError['severity'] = 'error';

	for (const line of text.split('\n')) {
		const included = /^\s*(Error|Warning)\s*:\s*in included file\s+'([^']+)'\s*$/i.exec(line.trim());
		if (included) {
			file = included[2]!.trim();
			severity = /^warn/i.test(included[1]!) ? 'warning' : 'error';
			continue;
		}
		const named = /^\s*(Error|Warning)\s*:\s*Line\s+(\d+)\s*-\s*(.*)$/i.exec(line.trim());
		if (named) {
			errors.push({
				file: '',
				line: Number(named[2]),
				message: named[3]!.trim(),
				severity: /^warn/i.test(named[1]!) ? 'warning' : 'error',
			});
			continue;
		}
		const detail = /^\s*Line\s+(\d+)\s*-\s*(.*)$/i.exec(line.trim());
		if (detail && file) {
			errors.push({ file, line: Number(detail[1]), message: detail[2]!.trim(), severity });
			file = '';
		}
	}
	return errors;
}
