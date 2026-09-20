export type PbSymbolKind =
	| 'procedure'
	| 'declare'
	| 'prototype'
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

export interface PbSymbol {
	name: string;
	kind: PbSymbolKind;

	line: number;

	endLine?: number;

	detail: string;

	scope: string;

	params?: string;

	returns?: string;

	type?: string;

	pointer?: boolean;

	container?: 'list' | 'map' | 'array';

	file: string;

	doc?: string;
}

export interface PbDocument {
	uri: string;
	text: string;

	symbols: PbSymbol[];

	includes: string[];

	includePaths: string[];
}

export interface PbBuiltinParam {
	mode?: string;
	name: string;
	type?: string;
}

export interface PbBuiltinSignature {
	text: string;

	label: string;
	params: PbBuiltinParam[];

	callIndex?: number;
}

export interface PbBuiltin {
	id: string;
	name: string;

	lower: string;
	kind: 'function' | 'sub' | 'keyword';
	category: string;
	library?: string;
	signatures?: PbBuiltinSignature[];
}

export interface PbBlock {
	opener: string;

	closers: string[];

	category: string;
}

export interface PbBuiltinData {
	source: string;

	generatedFrom?: string;
	count: number;

	keywords: string[];

	keywordCanonical: Record<string, string>;

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

	labelDescription?: string;
	kind: PbCompletionKind;
	detail: string;

	documentation?: string;

	insertText: string;

	isSnippet: boolean;

	sortText: string;

	filterText?: string;
}

export interface PbHover {
	contents: string;

	range: { startLine: number; startChar: number; endLine: number; endChar: number };
}

export type PbParameterLabel = string | [number, number];

export interface PbSignatureInfo {
	label: string;

	parameters: { label: PbParameterLabel; documentation?: string }[];

	activeParameter: number;
	documentation?: string;
}

export interface PbCompletionOptions {
	keywords: boolean;
	builtins: boolean;
	snippets: boolean;

	minChars?: number;
}

export interface PbPosition {
	line: number;
	character: number;
}
