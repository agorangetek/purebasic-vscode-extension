/*
 * Signature help for built-in commands and user procedures.
 *
 * The label is the compact call form ("MessageRequester(Title, Text, Flags)")
 * and parameters are reported as offsets into it, so the editor can highlight
 * the active parameter without having to guess which occurrence of a name is
 * the parameter.
 */
import { builtinMarkdown, declarationBlock, lookupBuiltin } from './builtins.ts';
import { callContextAt, parameterNames } from './parser.ts';
import type { PbDocument, PbParameterLabel, PbPosition, PbSignatureInfo, PbSymbol } from './types.ts';

/** Locate each name inside `label` as a whole word, in order. */
function labelOffsets(label: string, names: readonly string[]): PbParameterLabel[] {
	const labels: PbParameterLabel[] = [];
	let from = 0;
	for (const name of names) {
		if (!name) {
			labels.push('');
			continue;
		}
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(label.slice(from));
		if (!match) {
			labels.push(name);
			continue;
		}
		const start = from + match.index;
		const end = start + match[0].length;
		labels.push([start, end]);
		from = end;
	}
	return labels;
}

function userProcSignatures(
	document: PbDocument,
	callee: string,
	customSymbols: readonly PbSymbol[],
): PbSignatureInfo[] {
	const all = [...document.symbols, ...customSymbols].filter(
		(s) =>
			s.params !== undefined &&
			s.name.replace(/^[*@?]/, '').toLowerCase() === callee.toLowerCase(),
	);

	return all.map((symbol) => {
		const names = parameterNames(symbol.params);
		const label = `${symbol.name}(${symbol.params ?? ''})${symbol.returns ? `.${symbol.returns}` : ''}`;
		const offsets = labelOffsets(label, names);
		return {
			label,
			parameters: names.map((name, i) => ({ label: offsets[i] ?? name })),
			activeParameter: 0,
			documentation: symbol.doc,
		} satisfies PbSignatureInfo;
	});
}

export function getSignatureHelp(
	document: PbDocument,
	position: PbPosition,
	customSymbols: readonly PbSymbol[] = [],
): PbSignatureInfo | undefined {
	const context = callContextAt(document.text, position);
	if (!context) return undefined;

	const { callee, activeParameter } = context;

	// user procedures take precedence
	const user = userProcSignatures(document, callee, customSymbols);
	if (user.length > 0) return { ...user[0]!, activeParameter };

	const builtin = lookupBuiltin(callee);
	const signature = builtin?.signatures?.[0];
	if (!builtin || !signature) return undefined;

	const names = signature.params.map((p) => p.name ?? '');
	const offsets = labelOffsets(signature.label, names);

	return {
		label: signature.label,
		parameters: signature.params.map((p, i) => ({
			label: offsets[i] ?? names[i] ?? '',
			documentation: [p.mode === 'optional' ? 'optional' : '', p.type].filter(Boolean).join(' '),
		})),
		activeParameter: Math.min(activeParameter, Math.max(signature.params.length - 1, 0)),
		documentation: [declarationBlock(signature.text), builtinMarkdown(builtin)].join('\n\n'),
	};
}
