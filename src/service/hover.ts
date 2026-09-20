/*
 * Hover text for built-in commands and for the user's own symbols.
 */
import { builtinMarkdown, lookupBuiltin } from './builtins.ts';
import { wordAt } from './parser.ts';
import type { PbDocument, PbHover, PbPosition, PbSymbol } from './types.ts';

function symbolMarkdown(symbol: PbSymbol): string {
	const parts: string[] = [];
	const kind = symbol.kind;
	const signature = symbol.params !== undefined ? `${symbol.name}(${symbol.params})` : symbol.name;
	parts.push('```purebasic\n' + `${kind} ${signature}` + '\n```');
	if (symbol.doc) parts.push(symbol.doc);
	if (symbol.scope) parts.push(`*member of ${symbol.scope}*`);
	return parts.join('\n\n');
}

export function getHover(
	document: PbDocument,
	position: PbPosition,
	workspaceSymbols: readonly PbSymbol[] = [],
): PbHover | undefined {
	const found = wordAt(document.text, position);
	if (!found) return undefined;

	const { word, startChar, endChar } = found;
	const range = {
		startLine: position.line,
		startChar,
		endLine: position.line,
		endChar,
	};

	const name = word.replace(/^[*@?#]/, '');
	const builtin = lookupBuiltin(name);
	if (builtin) return { contents: builtinMarkdown(builtin), range };

	const symbol = [...document.symbols, ...workspaceSymbols].find(
		(s) => s.name.replace(/^[*@?#]/, '').toLowerCase() === name.toLowerCase(),
	);
	if (symbol) return { contents: symbolMarkdown(symbol), range };

	return undefined;
}
