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
	PbSymbolKind,
	PbSymbol,
} from './types.ts';

const RANK = {
	local: '0',
	document: '1',
	workspace: '2',
	builtin: '3',
	keyword: '4',
} as const;

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

export function fileNameOf(uri: string): string {
	const path = uri.split('#')[0] ?? uri;
	return baseNameOf(pathOfUri(path)) || uri;
}

export interface SymbolItemOptions {
	snippet?: boolean;

	group?: string;

	labelDescription?: string;

	address?: boolean;
}

export function symbolToCompletionItem(
	symbol: PbSymbol,
	rank: string,
	options: SymbolItemOptions = {},
): PbCompletionItem {
	const { snippet = false, group = '', labelDescription, address = false } = options;
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
		const emptyForm = symbol.container === 'list' || symbol.kind === 'list';
		insertText = emptyForm ? `${symbol.name}()` : `${symbol.name}(\${1})`;
		isSnippet = !emptyForm;
	} else if (isCallable && address) {
		insertText = `${symbol.name}()`;
	} else if (isCallable && params.length > 0 && snippet) {
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

export function enclosingProcedure(document: PbDocument, position: PbPosition): PbSymbol | undefined {
	let best: PbSymbol | undefined;
	for (const symbol of document.symbols) {
		if (symbol.kind !== 'procedure') continue;
		if (symbol.line > position.line) continue;

		if (symbol.endLine !== undefined && symbol.endLine < position.line) continue;
		if (!best || symbol.line > best.line) best = symbol;
	}
	return best;
}

function allFields(document: PbDocument, workspaceSymbols: readonly PbSymbol[]): PbSymbol[] {
	return [...document.symbols, ...workspaceSymbols].filter((s) => s.kind === 'field');
}

function plainName(name: string): string {
	return name.replace(/^[*@?]/, '').replace(/\$$/, '');
}

type MemberSource =
	| { kind: 'structure'; name: string }
	| { kind: 'leaf' }
	| { kind: 'unknown' };

function isNativeType(type: string): boolean {
	return Object.hasOwn(TYPE_SUFFIXES, type.toLowerCase());
}

function memberSource(
	document: PbDocument,
	workspaceSymbols: readonly PbSymbol[],
	before: string,
	position: PbPosition,
): MemberSource {
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

export function buildCompletions(request: CompletionRequest): PbCompletionItem[] {
	const { document, workspaceSymbols = [], position, options, word } = request;
	const items: PbCompletionItem[] = [];
	const seen = new Set<string>();
	const context = statementContextAt(document.text, position, word);
	const members = memberContextAt(document.text, position, word);

	const sigil = /^[*@?]/.test(word) ? word[0] : undefined;
	const address = sigil !== undefined;
	if (members === 'plain' && !address && (options.minChars ?? 0) > 0) {
		if (word.length < (options.minChars ?? 0)) return [];
	}

	const SIGIL_TARGETS: Record<string, readonly PbSymbolKind[]> = {
		'@': ['procedure', 'declare', 'variable', 'list', 'map', 'array'],
		'*': ['procedure', 'declare', 'variable', 'list', 'map', 'array'],
		'?': ['label'],
	};
	const targets = sigil === undefined ? undefined : SIGIL_TARGETS[sigil];
	const wants = (kind: PbSymbolKind) => targets === undefined || targets.includes(kind);

	const push = (item: PbCompletionItem) => {
		const key = item.label.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		items.push(item);
	};

	if (members === 'none') return [];

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
				push(symbolToCompletionItem(symbol, RANK.document, { labelDescription: from }));
			}
		} else {
			for (const field of memberItems(document, workspaceSymbols, context.before, position)) {
				const from = field.file === document.uri ? undefined : fileNameOf(field.file);
				const item = symbolToCompletionItem(field, RANK.local, { labelDescription: from });
				item.documentation = field.scope ? `member of ${field.scope}` : undefined;
				push(item);
			}
		}
		return filterByPrefix(items, word);
	}

	if (expectsName(context.before)) {
		return filterByPrefix(items, word);
	}

	const proc = enclosingProcedure(document, position);
	if (proc && wants('variable')) {
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
				push(symbolToCompletionItem(symbol, RANK.local, { address }));
			}
		}
	}

	for (const symbol of document.symbols) {
		if (symbol.scope === '' && wants(symbol.kind)) {
			push(symbolToCompletionItem(symbol, RANK.document, { address }));
		}
	}

	for (const symbol of workspaceSymbols) {
		if (symbol.file === document.uri) continue;

		if (symbol.kind === 'field' || !wants(symbol.kind)) continue;
		const file = fileNameOf(symbol.file);
		const item = symbolToCompletionItem(symbol, RANK.workspace, {
			group: file,
			labelDescription: file,
			address,
		});
		item.documentation = item.documentation
			? `${item.documentation}\n\n---\n\nFrom \`${file}\``
			: `From \`${file}\``;
		push(item);
	}

	const freshStatement = !sigil && /^\s*$/.test(context.before);

	if (options.builtins && !address) {
		for (const item of allBuiltins()) {
			if (item.kind === 'keyword') continue;
			if (!isCompletableName(item.name)) continue;
			push(builtinToCompletionItem(item, RANK.builtin, options.snippets));
		}
	}

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

	if (options.keywords && !sigil) {
		for (const item of allBuiltins()) {
			if (item.kind !== 'keyword') continue;
			if (!isCompletableName(item.name)) continue;
			push(builtinToCompletionItem(item, RANK.keyword, false));
		}
	}

	return filterByPrefix(items, word);
}

function filterByPrefix(items: PbCompletionItem[], word: string): PbCompletionItem[] {
	if (word.length === 0) return items;
	const prefix = word.replace(/^[*@?]/, '').toLowerCase();
	return items.filter((item) => (item.filterText ?? item.label).toLowerCase().startsWith(prefix));
}
