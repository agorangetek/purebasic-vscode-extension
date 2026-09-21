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

/**
 * The commands after which the program is running.
 *
 * Only then is what arrives the program's own output.  Everything else the
 * console prints is an answer to something this adapter asked -- the variable
 * dump, the procedure history, the list of files -- and putting that in the
 * debug console alongside the program's output would be burying it.
 */
const RUNNING = new Set(['run', 'step']);

/**
 * How long a command the program is not held by is given to answer.
 *
 * The same grace `ready()` gives the console to come up: long enough for a slow
 * answer, short enough that a debugger which has stopped answering -- a child
 * that died, a prompt that was lost -- leaves an error rather than a caller
 * waiting for ever.
 */
const ANSWER_TIMEOUT = 20000;

/** One turn of the conversation: a command, and the promise its caller holds. */
interface Turn {
	command: string;
	resolve: (text: string) => void;
	/** How long to wait once it is written; 0 is as long as it takes. */
	timeoutMs: number;
}

export class DebugConsole {
	private pty: PtyProcess;
	private callbacks: ConsoleCallbacks;
	/** What has arrived and not been accounted for yet. */
	private buffer = '';
	/** How much of the buffer has been looked at for program output. */
	private cursor = 0;
	/** The command the console has, and has not answered yet. */
	private pending: Turn | undefined;
	/** Commands issued while one was in flight: the console takes them one at a time. */
	private queue: Turn[] = [];
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

	/**
	 * Send one command, and resolve with everything it printed in reply.
	 *
	 * Only one command is in flight at a time.  The console answers into the
	 * same stream its prompts come back on, so a second command written while
	 * the first is unanswered would be answered to the wrong caller: a command
	 * that arrives while another is in flight is queued, and sent when that one
	 * has been answered.
	 */
	command(text: string, timeoutMs = 0): Promise<string> {
		if (this.ended) return Promise.resolve('');
		// a command that leaves the program running comes back only when the
		// program stops, which is not this adapter's to decide, so it waits as
		// long as it takes; everything else gets a bounded wait, since there is
		// nothing else to end the wait of a console that has gone quiet
		const wait = timeoutMs > 0 ? timeoutMs : RUNNING.has(text.trim()) ? 0 : ANSWER_TIMEOUT;
		return new Promise<string>((resolve) => {
			const turn: Turn = { command: text, resolve, timeoutMs: wait };
			if (this.pending) this.queue.push(turn);
			else this.write(turn, `${text}\n`);
		});
	}

	/**
	 * Interrupt the program: Ctrl+C opens the console prompt, which is the
	 * documented way to stop a running program from the command-line debugger.
	 *
	 * The interrupt is never queued: it is what stops a running program, and a
	 * `run` in flight is answered only when the program stops, so waiting for
	 * its turn would be waiting for the very thing the interrupt is here to
	 * end.  Whatever is in flight is answered with what it has printed so far,
	 * and the Ctrl+C goes out at once.
	 */
	interrupt(timeoutMs = 5000): Promise<string> {
		if (this.ended) return Promise.resolve('');
		const running = this.pending;
		this.pending = undefined;
		if (running) running.resolve(this.withoutEcho(this.buffer, running.command));
		return new Promise<string>((resolve) => {
			// Ctrl+C is a key rather than a line, so it goes without a newline
			this.write({ command: '\u0003', resolve, timeoutMs }, '\u0003');
		});
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
		// the last line printed before the prompt has no newline of its own, so
		// `forward` left it in the buffer: a program's `Print` with no newline
		// right before it stops is still its output, and belongs in the panel
		this.forwardLine(this.buffer.slice(this.cursor, at).replace(/\r/g, ''));
		const reply = this.buffer.slice(0, at);
		this.buffer = this.buffer.slice(end);
		this.cursor = 0;

		if (this.pending) {
			const pending = this.pending;
			this.pending = undefined;
			pending.resolve(this.withoutEcho(reply, pending.command));
			this.sendNext();
			return;
		}
		if (this.waiting) {
			const waiting = this.waiting;
			this.waiting = undefined;
			this.up = true;
			waiting(reply);
		}
	}

	/** Write a command, and make it the one the console is answering. */
	private write(turn: Turn, text: string): void {
		this.pending = turn;
		this.pty.write(text);
		if (turn.timeoutMs > 0) setTimeout(() => this.expire(turn), turn.timeoutMs);
	}

	/** The next command that was waiting its turn, now that one is over. */
	private sendNext(): void {
		const next = this.queue.shift();
		if (next) this.write(next, `${next.command}\n`);
	}

	/**
	 * Give up on a command the console has not answered.
	 *
	 * The reply can still arrive later, so this is a safety net for a debugger
	 * that has gone quiet rather than a promise that no answer is coming: what
	 * arrives after its turn is over is taken by whatever is waiting then.
	 */
	private expire(turn: Turn): void {
		if (this.pending !== turn) return;
		this.pending = undefined;
		turn.resolve('');
		this.sendNext();
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
		if (!this.pending || line.trim() === this.pending.command.trim()) return;
		// and neither is an answer to a question this adapter asked
		if (!RUNNING.has(this.pending.command.trim())) return;
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
		// nothing will be answered now, so the commands still waiting their turn
		// are let go rather than left holding a promise for ever
		const queued = this.queue;
		this.queue = [];
		const waiting = this.waiting;
		this.waiting = undefined;
		if (waiting) {
			this.up = true;
			waiting(this.buffer);
		}
		if (pending) pending.resolve(this.buffer);
		for (const turn of queued) turn.resolve('');
		this.callbacks.onExit?.(code);
	}
}
