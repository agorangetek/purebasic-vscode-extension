/*
 * The debugger's command line, as a conversation.
 *
 * The console prints `DEBUGGER::` when it is ready for a command and then waits,
 * so a command and its answer are one turn of a conversation: write the command,
 * read until the prompt comes back.  What the program itself prints is passed on
 * as it arrives rather than at the end of the turn, which is what makes the
 * debug console fill up while the program runs.
 *
 * Editor-agnostic: no 'vscode' import.
 */
import { parseProgramOutput } from './parse.ts';
import type { PtyProcess } from './pty.ts';

export interface ConsoleCallbacks {
	/** The program's own output, as it arrives. */
	onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
	/** Once, when the program is gone. */
	onExit?: (code: number) => void;
}

/** The prompt the console prints when it wants a command. */
const PROMPT = 'DEBUGGER::';

export class DebugConsole {
	private pty: PtyProcess;
	private callbacks: ConsoleCallbacks;
	/** What has arrived and not been accounted for yet. */
	private buffer = '';
	/** How much of the buffer has been looked at for program output. */
	private cursor = 0;
	private pending: { command: string; resolve: (text: string) => void } | undefined;
	private waiting: ((text: string) => void) | undefined;
	private started: Promise<string>;
	/** Until the first prompt, everything printed is the console coming up. */
	private up = false;
	ended = false;

	constructor(pty: PtyProcess, callbacks: ConsoleCallbacks = {}) {
		this.pty = pty;
		this.callbacks = callbacks;
		this.started = new Promise((resolve) => {
			this.waiting = resolve;
		});
		pty.onData((text) => this.receive(text));
		pty.onExit((code) => this.finish(code));
	}

	/** Resolves once the console has printed its first prompt. */
	async ready(timeoutMs = 20000): Promise<string> {
		if (this.up) return '';
		const timeout = new Promise<string>((_resolve, reject) => {
			setTimeout(() => reject(new Error('the debugger did not come up')), timeoutMs);
		});
		return Promise.race([this.started, timeout]);
	}

	/** Send one command, and resolve with everything it printed in reply. */
	command(text: string, timeoutMs = 0): Promise<string> {
		if (this.ended) return Promise.resolve('');
		const answer = new Promise<string>((resolve) => {
			this.pending = { command: text, resolve };
			if (timeoutMs > 0) {
				setTimeout(() => {
					if (this.pending?.command === text) {
						this.pending = undefined;
						resolve('');
					}
				}, timeoutMs);
			}
		});
		this.pty.write(`${text}\n`);
		return answer;
	}

	/**
	 * Interrupt the program: Ctrl+C opens the console prompt, which is the
	 * documented way to stop a running program from the command-line debugger.
	 */
	interrupt(timeoutMs = 5000): Promise<string> {
		if (this.ended) return Promise.resolve('');
		const answer = new Promise<string>((resolve) => {
			this.pending = { command: '\u0003', resolve };
			setTimeout(() => {
				if (this.pending?.command === '\u0003') {
					this.pending = undefined;
					resolve('');
				}
			}, timeoutMs);
		});
		this.pty.write('\u0003');
		return answer;
	}

	/** The console's answer to a question it has to ask: `(y,N)` and the like. */
	answer(text: string): void {
		this.pty.write(`${text}\n`);
	}

	close(): void {
		this.pty.kill();
	}

	private receive(text: string): void {
		this.buffer += text;
		this.forward();

		const at = this.buffer.indexOf(PROMPT);
		if (at === -1) return;

		let end = at + PROMPT.length;
		if (this.buffer[end] === ' ') end++;
		const reply = this.buffer.slice(0, at);
		this.buffer = this.buffer.slice(end);
		this.cursor = 0;

		if (this.pending) {
			const pending = this.pending;
			this.pending = undefined;
			pending.resolve(this.withoutEcho(reply, pending.command));
			return;
		}
		if (this.waiting) {
			const waiting = this.waiting;
			this.waiting = undefined;
			this.up = true;
			waiting(reply);
		}
	}

	/** Pass on the complete lines that have arrived, one by one. */
	private forward(): void {
		if (!this.up) return;
		let at: number;
		while ((at = this.buffer.indexOf('\n', this.cursor)) !== -1) {
			const line = this.buffer.slice(this.cursor, at).replace(/\r/g, '');
			this.cursor = at + 1;
			this.forwardLine(line);
		}
	}

	private forwardLine(line: string): void {
		// the console echoes what is typed at it; that is not the program talking
		if (this.pending && line.trim() === this.pending.command.trim()) return;
		for (const printed of parseProgramOutput(line)) this.callbacks.onOutput?.(printed.stream, printed.text);
	}

	/** Drop the echoed command from the front of a reply. */
	private withoutEcho(reply: string, command: string): string {
		const lines = reply.replace(/\r/g, '').split('\n');
		if (lines.length > 0 && lines[0]!.trim() === command.trim()) lines.shift();
		return lines.join('\n');
	}

	private finish(code: number): void {
		this.ended = true;
		const pending = this.pending;
		this.pending = undefined;
		const waiting = this.waiting;
		this.waiting = undefined;
		if (waiting) {
			this.up = true;
			waiting(this.buffer);
		}
		if (pending) pending.resolve(this.buffer);
		this.callbacks.onExit?.(code);
	}
}
