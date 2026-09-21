/*
 * The debugger's settings file.
 *
 * The command-line debugger reads its settings from `~/.pbdebugger.prefs` on
 * macOS and Linux, and from `<PureBasic>\debugger\debugger.prefs` on Windows.
 * Two of them matter here: `CallOnStart` stops the program before it runs its
 * first line, which is what lets breakpoints be set before the program reaches
 * them -- without it the program is gone before there is anything to type at --
 * and `Errors` makes a runtime error open the console rather than ask a question
 * at a terminal nobody is watching.
 *
 * On the Unix systems the file goes into a directory of its own which is handed
 * to the program as its HOME, so the user's own debugger settings are never
 * touched.  Windows has no such indirection, so the file is written where the
 * debugger looks for it: kept as it was, and put back when the session ends.
 *
 * Editor-agnostic: no 'vscode' import.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Platform } from '../compiler.ts';

const SETTINGS = [
	'; PureBasic Debugger settings, written by the PureBasic extension for one',
	'; debug session. The originals are put back when the session ends.',
	'',
	'Numbers = dec',
	'Errors = console',
	'Warnings = display',
	'CallOnStart = 1',
	'CallOnEnd = 0',
	'',
].join('\n');

export interface DebuggerPreferences {
	/** The environment the program should be started with. */
	env: NodeJS.ProcessEnv;
	/** Put everything back as it was. */
	restore(): void;
}

/** Write the settings the debugger needs, for one session. */
export function writeDebuggerPreferences(options: {
	platform: Platform;
	env: NodeJS.ProcessEnv;
	/** The compiler, so the PureBasic directory can be found on Windows. */
	compiler: string;
}): DebuggerPreferences {
	if (options.platform !== 'win32') {
		const home = mkdtempSync(join(tmpdir(), 'purebasic-debugger-'));
		writeFileSync(join(home, '.pbdebugger.prefs'), SETTINGS);
		return {
			env: { ...options.env, HOME: home },
			restore: () => {
				try {
					rmSync(home, { recursive: true, force: true });
				} catch {
					// a temporary directory that will not go: nothing to do about it
				}
			},
		};
	}

	// <PureBasic>\Compilers\pbcompiler.exe -> <PureBasic>\debugger\debugger.prefs
	const file = join(dirname(dirname(options.compiler)), 'debugger', 'debugger.prefs');
	const before = existsSync(file) ? readFileSync(file) : undefined;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, SETTINGS);

	return {
		env: options.env,
		restore: () => {
			try {
				if (before === undefined) rmSync(file, { force: true });
				else writeFileSync(file, before);
			} catch {
				// the settings stay as this session left them
			}
		},
	};
}
