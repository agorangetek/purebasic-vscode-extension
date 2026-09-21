/*
 * A terminal for the debugged program.
 *
 * PureBasic's command-line debugger will not open at all unless the program's
 * standard input is a terminal device -- it says so and carries on without it --
 * and the program reads the debugger's commands from that same terminal, so a
 * plain pipe is not enough.
 *
 * Only node-pty can give us one.  `script` looks like the obvious tool, and it
 * works when driven from a shell or from Python, but not from here: the pipes
 * node gives a child process are socket pairs, and `script` refuses those
 * ("tcgetattr/ioctl: Operation not supported on socket") whether it is handed
 * them as pipes or as files.  node-pty makes the terminal itself, which is what
 * the debugger is asking for.
 *
 * It is a native module, so it has to be there for the platform: the package
 * carries its prebuilt binaries for macOS and Windows.  A platform without one
 * is told so plainly rather than failing somewhere further in.
 *
 * Editor-agnostic: no 'vscode' import.
 */
import type { Platform } from '../compiler.ts';

/** A program running under a terminal of its own. */
export interface PtyProcess {
	/** Everything the program writes, as it writes it. */
	onData(listener: (text: string) => void): void;
	/** Once, when the program is gone. */
	onExit(listener: (code: number) => void): void;
	write(text: string): void;
	/** End the program, and the terminal with it. */
	kill(): void;
}

export interface PtyOptions {
	command: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	platform: Platform;
}

/** Start a program with a terminal of its own attached. */
export async function spawnWithPty(options: PtyOptions): Promise<PtyProcess> {
	let pty: typeof import('node-pty');
	try {
		pty = await import('node-pty');
	} catch (error) {
		throw new Error(
			`the terminal library has no build for this platform (${options.platform}): ${String(error)}`,
		);
	}

	const terminal = pty.spawn(options.command, [...options.args], {
		name: 'xterm-color',
		cwd: options.cwd,
		env: options.env as Record<string, string>,
		cols: 200,
		rows: 50,
	});

	return {
		onData: (listener) => {
			terminal.onData(listener);
		},
		onExit: (listener) => {
			terminal.onExit((event) => listener(event.exitCode));
		},
		write: (text) => {
			terminal.write(text);
		},
		kill: () => {
			terminal.kill();
		},
	};
}
