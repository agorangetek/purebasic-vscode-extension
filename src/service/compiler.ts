import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface CompilerSettings {
	path: string;
	debugger: boolean;
	optimizer: boolean;
	threadsafe: boolean;
	purifier: boolean;
	onErrorLines: boolean;
	executableFormat: 'macos' | 'console' | 'dylib';
	subsystem: string;

	outputPath: string;

	commandLine: string;

	quiet: boolean;
}

export function temporaryOutputFor(sourcePath: string): string {
	const name = basename(sourcePath).replace(/\.[^.]*$/, '');
	const stamp = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
	return join(tmpdir(), 'purebasic', `${name}-${stamp}`);
}

export function resolveCompiler(configured: string): string {
	const path = configured.trim();
	if (path) return path;

	const bundle = '/Applications/PureBasic.app/Contents/Resources/compilers/pbcompiler';
	if (existsSync(bundle)) return bundle;

	return 'pbcompiler';
}

export function compilerArguments(settings: CompilerSettings, outputPath?: string): string[] {
	const args: string[] = [];
	if (settings.debugger) args.push('-d');
	if (settings.threadsafe) args.push('-t');
	if (settings.optimizer) args.push('-z');
	if (settings.purifier) args.push('-pf');
	if (settings.onErrorLines) args.push('-l');
	if (settings.quiet) args.push('-q');
	if (settings.subsystem.trim()) args.push('-s', settings.subsystem.trim());

	// -dl names the library itself; -o is for the other two formats
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

export function outputPathFor(sourcePath: string, settings: CompilerSettings): string {
	const configured = settings.outputPath.trim();
	if (configured) return configured;
	const base = basename(sourcePath).replace(/\.[^.]*$/, '');
	if (settings.executableFormat === 'dylib') return join(dirname(sourcePath), `${base}.dylib`);
	return join(dirname(sourcePath), base);
}

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

// A command sent to a terminal reports nothing back, so the build writes
// its $? to a file and the run waits for that.
export async function waitForExitMarker(path: string, timeoutMs = 300_000): Promise<number | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = readFileSync(path, 'utf8').trim();
			if (text !== '') return Number.parseInt(text, 10);
		} catch {
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return undefined;
}

export function shellCommand(parts: readonly string[]): string {
	return parts.map(shellQuote).join(' ');
}

export function shellQuote(part: string): string {
	if (part.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(part)) return part;
	return `'${part.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether the program can be given a window of its own.
 *
 * macOS has one way to do this that needs no guesswork: a `.command` file, which
 * Terminal opens in a new window and runs.  Elsewhere there is no single answer
 * -- x-terminal-emulator, gnome-terminal, konsole, cmd -- and rather than guess,
 * those keep the terminal the editor provides.
 */
// macOS only: elsewhere there is no single terminal emulator to name, so
// the editor's own terminal stands in.
export function hasTerminalWindow(): boolean {
	return process.platform === 'darwin';
}

/**
 * A `.command` script that runs the program and leaves the window open.
 *
 * Terminal closes a window when its shell exits, so the output of a program that
 * ran and finished would vanish with it.  The script therefore reports the exit
 * status and hands the window to an interactive shell, the way the PureBasic IDE
 * leaves one behind.
 */
// A .command file is how Terminal is asked for a window of its own; the
// trailing shell is there because Terminal closes a window when it exits.
export function writeLaunchScript(target: string, args: readonly string[], cwd: string): string {
	const lines = [
		'#!/bin/sh',
		`# PureBasic: written by the extension so the program gets a window of its own`,
		`cd ${shellQuote(cwd)}`,
		shellCommand([target, ...args]),
		'status=$?',
		`printf '\\n[PureBasic] the program exited with %s\\n' "$status"`,
		'exec "${SHELL:-/bin/sh}" -i',
		'',
	];
	const path = join(tmpdir(), `purebasic-run-${process.pid}-${Date.now()}.command`);
	writeFileSync(path, lines.join('\n'), { mode: 0o755 });
	return path;
}

/** Open a script in a Terminal window.  Rejects if `open` will not do it. */
export function openTerminalWindow(script: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('open', ['-a', 'Terminal', script], (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
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
