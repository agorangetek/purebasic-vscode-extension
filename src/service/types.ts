/*
 * Shared types for the PureBasic language service.
 *
 * Everything in src/service/ is editor-agnostic: it must not import 'vscode',
 * so it can be unit-tested with plain node and reused by another editor
 * front-end (or an LSP wrapper) later.
 *
 * Note: the service is written in "erasable syntax only" TypeScript (no enums,
 * no namespaces, no parameter properties) so node can run and test the .ts
 * sources directly via type stripping.
 */

export type PbSymbolKind =
	| 'procedure'
	| 'declare'
	| 'prototype'
	/** A function declared in an `Import`/`ImportC` body. */
	| 'import'
	| 'structure'
	| 'interface'
	| 'module'
	| 'enumeration'
	| 'enummember'
	| 'macro'
	| 'constant'
	| 'variable'
	| 'field'
	| 'list'
	| 'map'
	| 'array'
	| 'label';

/** A symbol declared in PureBasic source. */
export interface PbSymbol {
	name: string;
	kind: PbSymbolKind;
	/** Zero-based line of the declaration. */
	line: number;
	/**
	 * Procedures: zero-based line of the `EndProcedure` that closes the body,
	 * when one has been seen. Absent while the body is still open.
	 */
	endLine?: number;
	/** The declaration line, trimmed, for display. */
	detail: string;
	/** Enclosing procedure (or structure) for locals, or '' at module level. */
	scope: string;
	/** Procedures: parameter list as written, between the parentheses. */
	params?: string;
	/** Procedures: the `.type` suffix the manual writes after the name. */
	returns?: string;
	/** Variables/fields: the `.type` suffix as written. */
	type?: string;
	/** Whether the name carries a leading `*` (a pointer, and part of the name). */
	pointer?: boolean;
	/**
	 * A List, Map or Array field, reached through parentheses -- `list()`,
	 * `map(key)`, `array(i)` -- rather than by name alone.
	 */
	container?: 'list' | 'map' | 'array';
	/** Absolute path (or uri) of the file the symbol came from. */
	file: string;
	/** Extra text for hover (documentation comment above the declaration). */
	doc?: string;
}

export interface PbDocument {
	uri: string;
	text: string;
	/** Symbols declared in this document, module level and locals. */
	symbols: PbSymbol[];
	/** Raw IncludeFile/XIncludeFile targets, in order. */
	includes: string[];
	/** Raw IncludePath directories, in order; they extend the search path. */
	includePaths: string[];
}

export interface PbBuiltinParam {
	mode?: string;
	name: string;
	type?: string;
}

export interface PbBuiltinSignature {
	/** Full signature as the manual writes it, e.g. "MessageRequester(Title.s, Text.s [, Flags.i])". */
	text: string;
	/** Compact call label, e.g. "MessageRequester(Title.s, Text.s, Flags.i)". */
	label: string;
	params: PbBuiltinParam[];
	/** Where the call itself starts in `text`, or -1. */
	callIndex?: number;
}

export interface PbBuiltin {
	/** Stable unique key: "<lowercase name>|<kind>". */
	id: string;
	name: string;
	/** Lower-case lookup key. */
	lower: string;
	kind: 'function' | 'sub' | 'keyword';
	category: string;
	library?: string;
	signatures?: PbBuiltinSignature[];
}

/** A folding block: what opens it and the terminator(s) that close it. */
export interface PbBlock {
	/** The word(s) that open the block, e.g. "Procedure", "ForEach". */
	opener: string;
	/** The word(s) that close it, e.g. ["EndProcedure"], ["Until", "Forever"]. */
	closers: string[];
	/** Keyword category the opener belongs to. */
	category: string;
}

export interface PbBuiltinData {
	source: string;
	count: number;
	/** Canonical spelling of every reserved word. */
	keywords: string[];
	/** Lower-cased reserved word -> canonical spelling. */
	keywordCanonical: Record<string, string>;
	/** Built-in variable type suffixes (b, a, c, w, u, l, i, f, q, d, s). */
	typeSuffixes: string[];
	blocks: PbBlock[];
	items: PbBuiltin[];
}

export type PbCompletionKind =
	| 'function'
	| 'sub'
	| 'variable'
	| 'field'
	| 'constant'
	| 'type'
	| 'keyword'
	| 'label'
	| 'module'
	| 'macro';

export interface PbCompletionItem {
	label: string;
	/**
	 * Rendered dimmed after the label. Set to the file that defines the symbol
	 * when it comes from another file, so a popup full of workspace symbols says
	 * where each one lives.
	 */
	labelDescription?: string;
	kind: PbCompletionKind;
	detail: string;
	/** Markdown documentation, shown in the completion popup and on hover. */
	documentation?: string;
	/** Text or snippet to insert. */
	insertText: string;
	/** Whether insertText contains snippet placeholders (${1:name}). */
	isSnippet: boolean;
	/** Lower sorts first: locals, document, workspace, builtins, keywords. */
	sortText: string;
	/** Extra prefix text used for filtering only. */
	filterText?: string;
}

export interface PbHover {
	/** Markdown. */
	contents: string;
	/** 0-based line/character range of the hovered word. */
	range: { startLine: number; startChar: number; endLine: number; endChar: number };
}

/** A parameter label is either literal text or a [start, end] offset pair into
 * the signature label, which is what editors need to highlight reliably. */
export type PbParameterLabel = string | [number, number];

export interface PbSignatureInfo {
	/** The call label, e.g. "MessageRequester(Title, Text, Flags)". */
	label: string;
	/** One entry per parameter, in order. */
	parameters: { label: PbParameterLabel; documentation?: string }[];
	/** Zero-based index of the active parameter. */
	activeParameter: number;
	documentation?: string;
}

export interface PbCompletionOptions {
	keywords: boolean;
	builtins: boolean;
	snippets: boolean;
	/**
	 * How many characters to type before the completion list is offered.
	 * 0 (the default here) offers it immediately; the extension passes the
	 * user's `purebasic.completion.minChars`.  A member list, asked for by `.`
	 * or `\`, is never held back.
	 */
	minChars?: number;
}

/** A parsed token position: zero-based line and character. */
export interface PbPosition {
	line: number;
	character: number;
}
