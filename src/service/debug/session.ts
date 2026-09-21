/*
 * The debug adapter: VS Code's debugging interface, over the console debugger.
 *
 * VS Code talks DAP; the debugger talks a command line.  Everything here is the
 * translation between them: a breakpoint in the gutter becomes `breakset`,
 * Continue becomes `run`, the call stack comes from `line` and `history`, and
 * the variables view from `variables`, the container listings and `show`.
 *
 * Editor-agnostic: no 'vscode' import.  The few things that do need the editor
 * are passed in -- building the program, and putting the build's log in the
 * terminal -- which is what lets a session be driven without one.
 */
import { splitCommandLine, type CompilerSettings, type Platform } from '../compiler.ts';
import { DebugConsole } from './console.ts';
import {
	parseBreakpointSet,
	parseContainers,
	parseErrors,
	parseFiles,
	parseFrames,
	parseLocation,
	parseShow,
	parseVariables,
	type DebugLocation,
	type DebugVariable,
} from './parse.ts';
import { writeDebuggerPreferences, type DebuggerPreferences } from './prefs.ts';
import { spawnWithPty } from './pty.ts';

/** The one thread the command-line debugger shows. */
const THREAD = 1;

/** A DAP message, as far as this adapter looks at one. */
export interface DapMessage {
	seq?: number;
	type?: string;
	command?: string;
	event?: string;
	request_seq?: number;
	success?: boolean;
	message?: string;
	body?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
}

/** What the adapter needs from the editor, and cannot do itself. */
export interface DebugHost {
	trace(message: string): void;
	/** Build the program with the debugger in it. */
	build(
		source: string,
		settings: CompilerSettings,
		target: string,
	): Promise<{ ok: boolean; command: string; output: string }>;
	/** Put a finished build in the terminal, where compiler messages belong. */
	showBuild(target: string, command: string, output: string, note: string): void;
}

/** Where the debug session is, and what it runs. */
export interface LaunchOptions {
	/** The PureBasic source to build and debug. */
	program: string;
	cwd: string;
	/** Arguments for the program itself, as a command line spells them. */
	args: string;
	settings: CompilerSettings;
	platform: Platform;
	/** Where the build is put, and what is started. */
	target: string;
}

/** What a variables reference stands for. */
interface Handle {
	kind: 'scope' | 'container' | 'struct';
	name: string;
	/** For a scope: which frame of the stack it belongs to. */
	frame: number;
	children: DebugVariable[];
}

/** How the program came to be stopped. */
type Stop = 'entry' | 'pause' | 'step' | 'breakpoint';

export class PureBasicDebugSession {
	private host: DebugHost;
	private console: DebugConsole | undefined;
	private preferences: DebuggerPreferences | undefined;
	private options: LaunchOptions | undefined;
	/** The debugger's own file names and numbers, once it is up. */
	private files: { number: number; name: string }[] = [];
	/** What the debugger is holding, per source file the editor named. */
	private applied = new Map<string, { line: number; id: number }[]>();
	/** Breakpoints set for a step, to be taken away again when it stops. */
	private temporary: number[] = [];
	private handles = new Map<number, Handle>();
	private nextHandle = 1;
	/** The frames the last stop produced, innermost first. */
	private frames: { procedure: string; location: DebugLocation }[] = [];
	/** The variables of this stop, so one stop does not ask for them twice. */
	private scopeCache: { name: string; procedure: string; frame: number; variables: DebugVariable[] }[] | undefined;
	private ended = false;
	/** The number the next message this adapter sends will carry. */
	private sequence = 0;
	/** Everything the adapter says to the editor. */
	onMessage: (message: DapMessage) => void = () => {};

	constructor(host: DebugHost) {
		this.host = host;
	}

	dispose(): void {
		this.end();
	}

	/** A message from the editor. */
	handle(message: DapMessage): void {
		void this.dispatch(message);
	}

	private async dispatch(request: DapMessage): Promise<void> {
		try {
			switch (request.command) {
				case 'initialize':
					this.respond(request, {
						supportsConfigurationDoneRequest: true,
						supportsTerminateRequest: true,
						supportsSetVariable: true,
						supportsEvaluateForHovers: true,
						// the debugger steps a line at a time, and `databreak` is
						// not a condition on a line, so neither is claimed here
						supportsConditionalBreakpoints: false,
						exceptionBreakpointFilters: [],
					});
					break;
				case 'launch':
					await this.launch(request);
					break;
				case 'setBreakpoints':
					await this.setBreakpoints(request);
					break;
				case 'setExceptionBreakpoints':
					this.respond(request);
					break;
				case 'configurationDone':
					this.respond(request);
					void this.begin();
					break;
				case 'threads':
					this.respond(request, { threads: [{ id: THREAD, name: 'Main' }] });
					break;
				case 'stackTrace':
					await this.stackTrace(request);
					break;
				case 'scopes':
					await this.scopes(request);
					break;
				case 'variables':
					await this.variables(request);
					break;
				case 'continue':
					this.respond(request, { allThreadsContinued: true });
					await this.resume('run', 'breakpoint');
					break;
				case 'next':
					await this.stepOver(request);
					break;
				case 'stepIn':
					this.respond(request);
					await this.resume('step', 'step');
					break;
				case 'stepOut':
					await this.stepOut(request);
					break;
				case 'pause':
					this.respond(request);
					await this.resume('\u0003', 'pause');
					break;
				case 'evaluate':
					await this.evaluate(request);
					break;
				case 'setVariable':
					await this.setVariable(request);
					break;
				case 'disconnect':
				case 'terminate':
					this.respond(request);
					this.end();
					break;
				default:
					this.fail(request, `${request.command ?? 'that'} is not supported`);
			}
		} catch (error) {
			this.host.trace(`debugger: ${request.command ?? '?'}: ${String(error)}`);
			this.fail(request, String(error));
		}
	}

	// ---------------------------------------------------------------- startup

	/**
	 * Build the program, and start it under the debugger.
	 *
	 * It is built first, so a file that does not compile is reported in the
	 * terminal and no session is started around it.  It is then started with the
	 * debugger's settings written for it, which stop it before its first line:
	 * the breakpoints arrive after this, and the program must not have run past
	 * them by then.
	 */
	private async launch(request: DapMessage): Promise<void> {
		const args = request.arguments ?? {};
		const program = String(args.program ?? '');
		if (program === '') {
			this.fail(request, 'no PureBasic source to debug');
			return;
		}

		const options: LaunchOptions = {
			program,
			cwd: String(args.cwd ?? '') || dirnameOf(program),
			args: String(args.args ?? ''),
			settings: args.settings as CompilerSettings,
			platform: args.platform as Platform,
			target: String(args.target ?? ''),
		};
		this.options = options;

		// the debugger is what is being asked for, whatever the setting says
		const settings: CompilerSettings = { ...options.settings, debugger: true };
		const build = await this.host.build(program, settings, options.target);
		if (!build.ok) {
			this.host.showBuild(options.target, build.command, build.output, 'the build failed, so nothing was started');
			this.fail(request, 'the build failed');
			return;
		}

		this.preferences = writeDebuggerPreferences({
			platform: options.platform,
			env: process.env,
			compiler: String(args.compiler ?? ''),
		});

		const started = await spawnWithPty({
			command: options.target,
			args: splitCommandLine(options.args),
			cwd: options.cwd,
			env: this.preferences.env,
			platform: options.platform,
		});

		this.console = new DebugConsole(started, {
			onOutput: (stream, text) => {
				this.event('output', { category: stream, output: text });
			},
			onExit: () => {
				this.finish();
			},
		});

		await this.console.ready();
		const listed = await this.console.command('files');
		this.files = parseFiles(listed);
		this.host.trace(
			this.files.length > 0
				? `debugger: files ${this.files.map((file) => `${file.number}=${file.name}`).join(' ')}`
				: `debugger: the debugger named no files: ${JSON.stringify(listed)}`,
		);

		this.respond(request);
		this.event('initialized');
	}

	/** Everything is set: let the program run to whatever stops it first. */
	private async begin(): Promise<void> {
		if (!this.console || this.ended) return;
		await this.resume('run', 'entry');
	}

	// ------------------------------------------------------------ breakpoints

	/**
	 * Put the editor's breakpoints into the debugger.
	 *
	 * The debugger takes one line at a time and gives back a number for it, and
	 * it knows its files by name rather than by path, so the file the editor
	 * named is matched to the debugger's own list first.  A file it does not know
	 * -- one that is not part of the program -- leaves its breakpoints
	 * unverified rather than pretending they were set.
	 */
	private async setBreakpoints(request: DapMessage): Promise<void> {
		const args = request.arguments ?? {};
		const source = args.source as { path?: string } | undefined;
		const path = source?.path ?? '';
		const wanted = (args.breakpoints as { line: number }[] | undefined) ?? [];
		const console = this.console;
		const file = this.fileFor(path);

		if (!console || file === undefined) {
			this.respond(request, {
				breakpoints: wanted.map((breakpoint) => ({ verified: false, line: breakpoint.line })),
			});
			return;
		}

		for (const held of this.applied.get(path) ?? []) await console.command(`breakremove #${held.id}`);
		this.applied.delete(path);

		const applied: { line: number; id: number }[] = [];
		for (const breakpoint of wanted) {
			const id = parseBreakpointSet(await console.command(`breakset ${breakpoint.line}, ${file}`));
			if (id !== undefined) applied.push({ line: breakpoint.line, id });
		}
		this.applied.set(path, applied);

		this.respond(request, {
			breakpoints: wanted.map((breakpoint) => {
				const set = applied.find((held) => held.line === breakpoint.line);
				return { verified: set !== undefined, line: breakpoint.line, ...(set ? { id: set.id } : {}) };
			}),
		});
	}

	// -------------------------------------------------------------- the stops

	/**
	 * Run the program on, and say where it stopped.
	 *
	 * A command comes back when the program stops -- at a breakpoint, at the end
	 * of a step, or on an error -- so what stopped it is worked out from what the
	 * debugger printed and from where the program now is.
	 */
	private async resume(command: string, kind: Stop): Promise<void> {
		const console = this.console;
		if (!console || this.ended) return;

		this.event('continued', { threadId: THREAD, allThreadsContinued: true });
		this.scopeCache = undefined;
		const reply = command === '\u0003' ? await console.interrupt() : await console.command(command);

		if (this.ended || console.ended) {
			this.finish();
			return;
		}
		await this.stoppedAfter(reply, kind);
	}

	/** Work out why the program is where it is, and tell the editor. */
	private async stoppedAfter(reply: string, kind: Stop): Promise<void> {
		const errors = parseErrors(reply);
		for (const error of errors) this.event('output', { category: 'stderr', output: `${error.message}\n` });

		const location = (await this.currentLocation()) ?? { file: '', line: 0 };
		await this.clearTemporary();
		this.frames = await this.currentFrames(location);

		const held = this.applied.get(this.pathFor(location.file))?.filter((one) => one.line === location.line) ?? [];
		const reason: Stop | 'exception' =
			errors.length > 0 ? 'exception' : kind === 'pause' ? 'pause' : held.length > 0 ? 'breakpoint' : kind === 'entry' ? 'entry' : 'step';

		this.event('stopped', {
			reason,
			threadId: THREAD,
			allThreadsStopped: true,
			...(errors.length > 0 ? { description: errors[0]!.message, text: errors[0]!.message } : {}),
			...(held.length > 0 ? { hitBreakpointIds: held.map((one) => one.id) } : {}),
		});
	}

	/** One line on: the line after this one, run to. */
	private async stepOver(request: DapMessage): Promise<void> {
		this.respond(request);
		const here = await this.currentLocation();
		await this.runToLine(here ? here.file : '', here ? here.line + 1 : 0);
	}

	/** Out of the procedure: the line after the one that called into it. */
	private async stepOut(request: DapMessage): Promise<void> {
		this.respond(request);
		const caller = this.frames[1];
		await this.runToLine(caller ? caller.location.file : '', caller ? caller.location.line + 1 : 0);
	}

	/** Stop at a line, by putting a breakpoint there the program will run into. */
	private async runToLine(file: string, line: number): Promise<void> {
		const console = this.console;
		const number = line > 0 ? this.fileFor(this.pathFor(file)) : undefined;
		if (!console || number === undefined) {
			// nothing to aim at -- a step is the best that can be done
			await this.resume('step', 'step');
			return;
		}
		const id = parseBreakpointSet(await console.command(`breakset ${line}, ${number}`));
		if (id !== undefined) this.temporary.push(id);
		await this.resume('run', 'step');
	}

	private async clearTemporary(): Promise<void> {
		const console = this.console;
		if (!console) return;
		for (const id of this.temporary) await console.command(`breakremove #${id}`);
		this.temporary = [];
	}

	// ------------------------------------------------------- stack and scopes

	private async stackTrace(request: DapMessage): Promise<void> {
		if (this.frames.length === 0) {
			const location = (await this.currentLocation()) ?? { file: '', line: 0 };
			this.frames = await this.currentFrames(location);
		}

		this.respond(request, {
			stackFrames: this.frames.map((frame, index) => ({
				id: index,
				name: frame.procedure || 'Main',
				line: frame.location.line,
				column: 1,
				source: { name: baseName(frame.location.file), path: this.pathFor(frame.location.file) },
			})),
			totalFrames: this.frames.length,
		});
	}

	private async scopes(request: DapMessage): Promise<void> {
		const frame = Number((request.arguments ?? {}).frameId ?? 0);
		const held = this.frames[frame];
		this.respond(request, {
			scopes: [
				{
					name: 'Local',
					present: Boolean(held && held.procedure !== ''),
					variablesReference: this.remember({ kind: 'scope', name: 'Local', frame, children: [] }),
					expensive: false,
				},
				{
					name: 'Global',
					present: true,
					variablesReference: this.remember({ kind: 'scope', name: 'Main', frame, children: [] }),
					expensive: false,
				},
			],
		});
	}

	private async variables(request: DapMessage): Promise<void> {
		const reference = Number((request.arguments ?? {}).variablesReference ?? 0);
		const handle = this.handles.get(reference);
		if (!handle) {
			this.respond(request, { variables: [] });
			return;
		}

		const found = await this.expand(handle);
		this.respond(request, {
			variables: found.map((variable) => ({
				name: variable.name,
				value: variable.container !== '' || variable.type === 'Struct' ? variable.type : variable.value,
				type: variable.type,
				variablesReference: this.referenceFor(variable),
			})),
		});
	}

	/** The children of a scope, a container or a structure. */
	private async expand(handle: Handle): Promise<DebugVariable[]> {
		if (handle.kind === 'struct') return handle.children;

		const console = this.console;
		if (!console) return [];

		if (handle.kind === 'container') {
			const shown = parseShow(await console.command(`show ${callName(handle.name)}`));
			if (shown.error !== '') {
				this.host.trace(`debugger: show ${handle.name}: ${shown.error}`);
				return [];
			}
			return shown.entries.map((entry) => ({
				name: entry.name,
				type: '',
				value: entry.value,
				children: [],
				container: '' as const,
			}));
		}

		const scopes = await this.scopeVariables(handle.frame);
		return scopes.find((scope) => scope.name === handle.name)?.variables ?? [];
	}

	/**
	 * The variables of a frame.
	 *
	 * The frame the program stopped in is the one `variables` describes; the
	 * arrays, lists and maps are asked for separately, because the dump names
	 * them but does not print them.  Frames further out have no variables of
	 * their own here: the console only describes the one it stopped in.
	 */
	private async scopeVariables(frame: number): Promise<{ name: string; procedure: string; frame: number; variables: DebugVariable[] }[]> {
		if (!this.scopeCache) {
			const console = this.console;
			if (!console) return [];

			const scopes = parseVariables(await console.command('variables')).map((scope) => ({ ...scope, frame: 0 }));
			const containers = parseContainers(
				(await console.command('arrays')) + (await console.command('linkedlists')) + (await console.command('maps')),
			);
			const main = scopes.find((scope) => scope.name === 'Main');
			if (main) main.variables.push(...containers);
			this.scopeCache = scopes;
		}
		return this.scopeCache.filter((scope) => scope.frame === frame);
	}

	/** The frames at this stop: where the program is, and what called it there. */
	private async currentFrames(location: DebugLocation): Promise<{ procedure: string; location: DebugLocation }[]> {
		const console = this.console;
		if (!console) return [{ procedure: '', location }];

		const scopes = await this.scopeVariables(0);
		const frames = [{ procedure: scopes.find((scope) => scope.name === 'Local')?.procedure ?? '', location }];
		for (const frame of parseFrames(await console.command('history'))) {
			frames.push({ procedure: frame.procedure, location: { file: frame.file, line: frame.line } });
		}
		return frames;
	}

	private async currentLocation(): Promise<DebugLocation | undefined> {
		const console = this.console;
		if (!console) return undefined;
		return parseLocation(await console.command('line'));
	}

	// ------------------------------------------------------------- the values

	private async evaluate(request: DapMessage): Promise<void> {
		const console = this.console;
		const expression = String((request.arguments ?? {}).expression ?? '');
		if (!console || expression === '') {
			this.respond(request, { result: '', variablesReference: 0 });
			return;
		}
		const reply = await console.command(`debug ${expression}`);
		const printed = /\[Debugger\]\s\s?(.*)/.exec(reply.replace(/\r/g, ''))?.[1] ?? reply.trim();
		this.respond(request, { result: printed, variablesReference: 0 });
	}

	private async setVariable(request: DapMessage): Promise<void> {
		const console = this.console;
		const args = request.arguments ?? {};
		const name = String(args.name ?? '');
		const value = String(args.value ?? '');
		if (!console || name === '') {
			this.respond(request);
			return;
		}
		await console.command(`set ${name}=${value}`);
		this.scopeCache = undefined;
		this.respond(request, { value, variablesReference: 0 });
	}

	// ---------------------------------------------------------------- the end

	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		this.event('terminated');
	}

	private end(): void {
		const console = this.console;
		this.console = undefined;
		void console?.command('exit', 1000);
		console?.close();
		this.preferences?.restore();
		this.preferences = undefined;
		this.finish();
	}

	// ------------------------------------------------------------------ paths

	/** The debugger's own number for a file the editor named. */
	private fileFor(path: string): number | undefined {
		const wanted = baseName(path).toLowerCase();
		const found = this.files.filter((file) => baseName(file.name).toLowerCase() === wanted);
		if (found.length > 1) this.host.trace(`debugger: ${wanted} is ${found.length} of its files; taking the first`);
		return found[0]?.number;
	}

	/** The path a debugger file name stands for. */
	private pathFor(name: string): string {
		if (name === '') return '';
		if (baseName(this.options?.program ?? '').toLowerCase() === baseName(name).toLowerCase()) return this.options!.program;
		return joinPath(this.options?.cwd ?? '', name);
	}

	private referenceFor(variable: DebugVariable): number {
		if (variable.container !== '') return this.remember({ kind: 'container', name: variable.name, frame: 0, children: [] });
		if (variable.type === 'Struct') return this.remember({ kind: 'struct', name: variable.name, frame: 0, children: variable.children });
		return 0;
	}

	private remember(handle: Handle): number {
		const id = this.nextHandle++;
		this.handles.set(id, handle);
		return id;
	}

	// ------------------------------------------------------------ the talking

	/**
	 * Say something to the editor, numbered as the protocol requires: every
	 * message an adapter sends carries a sequence of its own, and a client is
	 * entitled to drop the ones that do not.
	 */
	private say(message: DapMessage): void {
		this.sequence += 1;
		this.onMessage({ ...message, seq: this.sequence });
	}

	private respond(request: DapMessage, body?: Record<string, unknown>): void {
		this.say({ type: 'response', request_seq: request.seq, success: true, command: request.command, body });
	}

	private fail(request: DapMessage, message: string): void {
		this.say({ type: 'response', request_seq: request.seq, success: false, command: request.command, message });
	}

	private event(event: string, body?: Record<string, unknown>): void {
		this.say({ type: 'event', event, body });
	}
}

/** The file name without its directory, whichever separator it uses. */
function baseName(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] ?? path;
}

function dirnameOf(path: string): string {
	const parts = path.split(/[\\/]/);
	parts.pop();
	return parts.join('/');
}

function joinPath(directory: string, name: string): string {
	return directory === '' ? name : `${directory.replace(/[\\/]$/, '')}/${name}`;
}

/** A container's name as `show` wants it: `garray(5)` is asked for as `garray()`. */
function callName(name: string): string {
	return `${name.replace(/\(.*$/, '')}()`;
}
