/*
 * Completion item construction.  Editor-agnostic: returns plain objects that
 * the VS Code layer (src/extension.ts) converts to vscode.CompletionItem.
 */
import { allBlocks, allBuiltins, builtinMarkdown, isCompletableName } from './builtins.ts';
import { blockBody, blockContinuations, expectsName, isDeclarationPrefix } from './blocks.ts';
import { baseNameOf, pathOfUri } from './includes.ts';
import { memberContextAt, parameterNames, statementContextAt } from './parser.ts';
import type {
	PbBuiltin,
	PbCompletionItem,
	PbCompletionKind,
	PbCompletionOptions,
	PbDocument,
	PbPosition,
	PbSymbol,
} from './types.ts';

/** Lower sorts first. */
const RANK = {
	local: '0',
	document: '1',
	workspace: '2',
	builtin: '3',
	keyword: '4',
} as const;

/** The built-in type suffixes, with what they mean. */
const TYPE_SUFFIXES: Record<string, string> = {
	b: 'Byte, 1 byte',
	a: 'Ascii, 1 byte',
	c: 'Character, 2 bytes',
	w: 'Word, 2 bytes',
	u: 'Unicode, 2 bytes',
	l: 'Long, 4 bytes',
	i: 'Integer, compiler sized',
	f: 'Float, 4 bytes',
	q: 'Quad, 8 bytes',
	d: 'Double, 8 bytes',
	s: 'String',
};

function symbolKindToCompletion(kind: PbSymbol['kind']): PbCompletionKind {
	switch (kind) {
		case 'procedure':
		case 'declare':
		case 'prototype':
			return 'function';
		case 'structure':
		case 'interface':
		case 'enumeration':
			return 'type';
		case 'module':
			return 'module';
		case 'macro':
			return 'macro';
		case 'constant':
		case 'enummember':
			return 'constant';
		case 'field':
			return 'field';
		case 'label':
			return 'label';
		default:
			return 'variable';
	}
}

function symbolDetail(symbol: PbSymbol): string {
	if (symbol.kind === 'procedure' || symbol.kind === 'declare' || symbol.kind === 'prototype') {
		const suffix = symbol.returns ? `.${symbol.returns}` : '';
		return `${symbol.kind} ${symbol.name}(${symbol.params ?? ''})${suffix}`;
	}
	return symbol.detail || `${symbol.kind} ${symbol.name}`;
}

/** The file name part of a uri, for the label of a symbol from another file. */
export function fileNameOf(uri: string): string {
	const path = uri.split('#')[0] ?? uri;
	return baseNameOf(pathOfUri(path)) || uri;
}

export function symbolToCompletionItem(
	symbol: PbSymbol,
	rank: string,
	allowSnippet = true,
	group = '',
	labelDescription?: string,
): PbCompletionItem {
	const isCallable =
		symbol.kind === 'procedure' || symbol.kind === 'declare' || symbol.kind === 'prototype';
	const params = parameterNames(symbol.params);

	let insertText = symbol.name;
	let isSnippet = false;
	const isContainer =
		symbol.kind === 'list' ||
		symbol.kind === 'map' ||
		symbol.kind === 'array' ||
		symbol.container !== undefined;
	if (isContainer) {
		/*
		 * A List, Map or Array is reached through its parentheses.  A list has a
		 * valid empty form -- `items()` reads the current element -- so it goes
		 * in as plain text and the caret ends up after it.  A map or an array
		 * needs a key or an index, so those get an empty placeholder instead.
		 * This is syntax rather than an argument list, so it is inserted
		 * whether or not call snippets are allowed here.
		 */
		const emptyForm = symbol.container === 'list' || symbol.kind === 'list';
		insertText = emptyForm ? `${symbol.name}()` : `${symbol.name}(\${1})`;
		isSnippet = !emptyForm;
	} else if (isCallable && params.length > 0 && allowSnippet) {
		const placeholders = params.map((p, i) => `\${${i + 1}:${p}}`).join(', ');
		insertText = `${symbol.name}(${placeholders})`;
		isSnippet = true;
	}

	return {
		label: symbol.name,
		labelDescription,
		kind: symbolKindToCompletion(symbol.kind),
		detail: symbolDetail(symbol),
		documentation: symbol.doc,
		insertText,
		isSnippet,
		// `group` keeps the symbols of one file together; the editor sorts by
		// match quality first, so it only decides between equally good matches.
		sortText: rank + group + symbol.name.toLowerCase(),
	};
}

export function builtinToCompletionItem(
	item: PbBuiltin,
	rank: string,
	allowSnippet: boolean,
): PbCompletionItem {
	const signature = item.signatures?.[0];
	const params = signature?.params ?? [];

	let insertText = item.name;
	let isSnippet = false;
	// every PureBasic command is called with parentheses, so a command with
	// parameters always gets a call snippet
	if (allowSnippet && params.length > 0) {
		const placeholders = params
			.map((p, i) => `\${${i + 1}:${(p.name || 'arg').replace(/^[*@?#]/, '').replace(/\$$/, '') || 'arg'}}`)
			.join(', ');
		insertText = `${item.name}(${placeholders})`;
		isSnippet = true;
	}

	return {
		label: item.name,
		kind: item.kind === 'keyword' ? 'keyword' : item.kind === 'function' ? 'function' : 'sub',
		detail: signature?.label ?? item.name,
		documentation: builtinMarkdown(item),
		insertText,
		isSnippet,
		sortText: rank + item.name.toLowerCase(),
	};
}

export interface CompletionRequest {
	document: PbDocument;
	workspaceSymbols?: readonly PbSymbol[];
	position: PbPosition;
	word: string;
	options: PbCompletionOptions;
}

/** The procedure whose body contains `position`, if any. */
export function enclosingProcedure(document: PbDocument, position: PbPosition): PbSymbol | undefined {
	let best: PbSymbol | undefined;
	for (const symbol of document.symbols) {
		if (symbol.kind !== 'procedure') continue;
		if (symbol.line > position.line) continue;
		// a procedure that has already been closed above the cursor does not
		// enclose it
		if (symbol.endLine !== undefined && symbol.endLine < position.line) continue;
		if (!best || symbol.line > best.line) best = symbol;
	}
	return best;
}

/** The fields of every structure/interface the document knows about. */
function allFields(document: PbDocument, workspaceSymbols: readonly PbSymbol[]): PbSymbol[] {
	return [...document.symbols, ...workspaceSymbols].filter((s) => s.kind === 'field');
}

/** A name with its sigils off, so `*p`, `p$` and `p` are the same variable. */
function plainName(name: string): string {
	return name.replace(/^[*@?]/, '').replace(/\$$/, '');
}

/**
 * What stands before a `\`, and therefore what may be offered after it:
 *
 * - `structure`: a structure or interface, so its fields are the answer;
 * - `leaf`: a native type -- `.i`, a `$` string, a bare `*` pointer -- which has
 *   no members at all, so nothing is offered;
 * - `unknown`: nothing could be told (an undeclared name, a call, a `With`
 *   block), where every known field stays on offer rather than none.
 *
 * The chain is walked step by step: the first name is a declared variable and
 * each further `\name` step moves to the structure that field is declared as,
 * so `m\list()\` reaches the element structure of a List field and
 * `pt\inner\x` walks a nested structure.
 */
type MemberSource =
	| { kind: 'structure'; name: string }
	| { kind: 'leaf' }
	| { kind: 'unknown' };

/** A native PureBasic type (`.i`, `.s`, ...): it has no members. */
function isNativeType(type: string): boolean {
	return Object.hasOwn(TYPE_SUFFIXES, type.toLowerCase());
}

function memberSource(
	document: PbDocument,
	workspaceSymbols: readonly PbSymbol[],
	before: string,
	position: PbPosition,
): MemberSource {
	// a step may carry an index or a key -- `list(0)`, `map("key")` -- and the
	// masked text turns a quoted key into spaces, so whitespace is allowed here
	const chain = /((?:[*@?]?[A-Za-z_]\w*)(?:\\[^\\]*)*)\\s*$/.exec(before)?.[1];
	if (chain === undefined) return { kind: 'unknown' };

	const steps = chain.split('\\').map((step) => /^[*@?]?([A-Za-z_]\w*)/.exec(step.trim())?.[1]);
	if (steps.length === 0 || steps.some((step) => step === undefined)) return { kind: 'unknown' };

	const fields = allFields(document, workspaceSymbols);
	const known = new Set(
		[...document.symbols, ...workspaceSymbols]
			.filter((symbol) => symbol.kind === 'structure' || symbol.kind === 'interface')
			.map((symbol) => symbol.name),
	);

	const scope = enclosingProcedure(document, position)?.name;
	const declared = document.symbols.filter(
		(symbol) =>
			plainName(symbol.name) === plainName(steps[0]!) &&
			(symbol.kind === 'variable' ||
				symbol.kind === 'field' ||
				symbol.kind === 'list' ||
				symbol.kind === 'map' ||
				symbol.kind === 'array'),
	);
	const first = declared.find((symbol) => symbol.scope === scope) ?? declared.find((symbol) => symbol.scope === '');
	// nothing declared at all tells us nothing; a declared name without a type
	// is a native variable, and a native variable has no members
	if (first === undefined) return { kind: 'unknown' };
	if (first.type === undefined) return { kind: 'leaf' };
	if (isNativeType(first.type)) return { kind: 'leaf' };
	if (!known.has(first.type)) return { kind: 'unknown' };

	let type: string = first.type;
	for (const step of steps.slice(1)) {
		const field = fields.find(
			(candidate) => candidate.scope === type && plainName(candidate.name) === plainName(step!),
		);
		if (field === undefined) return { kind: 'unknown' };
		const fieldType = field.type;
		if (fieldType === undefined) return { kind: 'leaf' };
		if (isNativeType(fieldType)) return { kind: 'leaf' };
		if (!known.has(fieldType)) return { kind: 'unknown' };
		type = fieldType;
	}
	return { kind: 'structure', name: type };
}

/**
 * The members to offer after a `\`: the fields of the structure the variable is
 * declared as, so a file with many structures shows the right ones.  When the
 * type is unknown, or the structure brings no fields of its own, every known
 * field is offered rather than nothing.
 */
function memberItems(
	document: PbDocument,
	workspaceSymbols: readonly PbSymbol[],
	before: string,
	position: PbPosition,
): PbSymbol[] {
	const fields = allFields(document, workspaceSymbols);
	const source = memberSource(document, workspaceSymbols, before, position);
	if (source.kind === 'leaf') return [];
	if (source.kind === 'unknown') return fields;
	return fields.filter((field) => field.scope === source.name);
}

/**
 * Build the completion list for a position.  Higher-priority sources come
 * first (locals, then this document, then the workspace, then the language),
 * and duplicates are dropped so the best-ranked entry wins.
 */
export function buildCompletions(request: CompletionRequest): PbCompletionItem[] {
	const { document, workspaceSymbols = [], position, options, word } = request;
	const items: PbCompletionItem[] = [];
	const seen = new Set<string>();
	const context = statementContextAt(document.text, position, word);
	const members = memberContextAt(document.text, position, word);

	// Editor-side pacing: while a name is being typed, wait until enough of it
	// is there before offering anything.  A member list after '.' or '\' is
	// asked for deliberately -- the editor only triggers it on the character
	// itself -- so it is never held back.
	if (members === 'plain' && (options.minChars ?? 0) > 0) {
		const typed = word.replace(/^[*@?]/, '');
		if (typed.length < (options.minChars ?? 0)) return [];
	}

	const push = (item: PbCompletionItem) => {
		const key = item.label.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		items.push(item);
	};

	// -- after '.' a type is expected; after '\' a structure member
	if (members === 'type' || members === 'member') {
		if (members === 'type') {
			for (const [suffix, description] of Object.entries(TYPE_SUFFIXES)) {
				push({
					label: suffix,
					kind: 'type',
					detail: `.${suffix} — ${description}`,
					insertText: suffix,
					isSnippet: false,
					sortText: RANK.keyword + '0' + suffix,
				});
			}
			for (const symbol of [...document.symbols, ...workspaceSymbols]) {
				if (symbol.kind !== 'structure' && symbol.kind !== 'interface') continue;
				const from = symbol.file === document.uri ? undefined : fileNameOf(symbol.file);
				push(symbolToCompletionItem(symbol, RANK.document, false, '', from));
			}
		} else {
			for (const field of memberItems(document, workspaceSymbols, context.before, position)) {
				const from = field.file === document.uri ? undefined : fileNameOf(field.file);
				const item = symbolToCompletionItem(field, RANK.local, false, '', from);
				item.documentation = field.scope ? `member of ${field.scope}` : undefined;
				push(item);
			}
		}
		return filterByPrefix(items, word);
	}

	// -- right after Procedure/Structure/Module/... a name is expected
	if (expectsName(context.before)) {
		return filterByPrefix(items, word);
	}

	// 1. locals and parameters of the enclosing procedure
	const proc = enclosingProcedure(document, position);
	if (proc) {
		for (const name of parameterNames(proc.params)) {
			const label = name.replace(/^[*@?]/, '');
			push({
				label,
				kind: 'variable',
				detail: `parameter of ${proc.name}`,
				insertText: name,
				isSnippet: false,
				sortText: RANK.local + label.toLowerCase(),
			});
		}
		for (const symbol of document.symbols) {
			if (symbol.scope === proc.name && symbol.name !== proc.name) {
				push(symbolToCompletionItem(symbol, RANK.local, false));
			}
		}
	}

	// 2. module-level symbols of this document
	for (const symbol of document.symbols) {
		if (symbol.scope === '') push(symbolToCompletionItem(symbol, RANK.document, false));
	}

	/*
	 * 3. symbols from other files in the workspace.  The popup has no row for a
	 * group heading, so every item carries the file that defines it after its
	 * label (CompletionItemLabel.description, the field VS Code documents for a
	 * file path) and the file name doubles as the sort key that keeps the
	 * symbols of one file together.
	 */
	for (const symbol of workspaceSymbols) {
		if (symbol.file === document.uri) continue;
		// a member is only valid after a `\`, which the branch above handles
		if (symbol.kind === 'field') continue;
		const file = fileNameOf(symbol.file);
		const item = symbolToCompletionItem(symbol, RANK.workspace, false, file, file);
		item.documentation = item.documentation
			? `${item.documentation}\n\n---\n\nFrom \`${file}\``
			: `From \`${file}\``;
		push(item);
	}

	// a fresh statement, with nothing on the line yet: where a block belongs
	const freshStatement = /^\s*$/.test(context.before);

	// 4. library commands are valid in any expression
	if (options.builtins) {
		for (const item of allBuiltins()) {
			if (item.kind === 'keyword') continue;
			if (!isCompletableName(item.name)) continue;
			push(builtinToCompletionItem(item, RANK.builtin, options.snippets));
		}
	}

	// 5. at the start of a statement, the block openers expand into a skeleton
	if (options.keywords && freshStatement && !isDeclarationPrefix(context.before)) {
		for (const block of allBlocks()) {
			const body = options.snippets ? blockBody(block) : undefined;
			push({
				label: block.opener,
				kind: 'keyword',
				detail: `${block.opener} ... ${block.closers.join(' / ')}`,
				documentation: `Insert a \`${block.opener}\` block, closed with \`${block.closers.join('` or `')}\`.`,
				insertText: body ?? block.opener,
				isSnippet: body !== undefined,
				sortText: RANK.keyword + (body ? '0' : '1') + block.opener.toLowerCase(),
			});
		}
		for (const { label, detail } of blockContinuations(allBlocks())) {
			push({
				label,
				kind: 'keyword',
				detail,
				insertText: label,
				isSnippet: false,
				sortText: RANK.keyword + '2' + label.toLowerCase(),
			});
		}
	}

	// 6. the rest of the language
	if (options.keywords) {
		for (const item of allBuiltins()) {
			if (item.kind !== 'keyword') continue;
			if (!isCompletableName(item.name)) continue;
			push(builtinToCompletionItem(item, RANK.keyword, false));
		}
	}

	return filterByPrefix(items, word);
}

/** Only what the typed text starts, whatever case was typed. */
function filterByPrefix(items: PbCompletionItem[], word: string): PbCompletionItem[] {
	if (word.length === 0) return items;
	const prefix = word.replace(/^[*@?]/, '').toLowerCase();
	return items.filter((item) => (item.filterText ?? item.label).toLowerCase().startsWith(prefix));
}
