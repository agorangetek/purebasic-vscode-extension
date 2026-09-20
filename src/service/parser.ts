/*
 * A lightweight PureBasic scanner.
 *
 * Deliberately not a full parser: it has to be fast enough to run on every
 * keystroke and forgiving enough to work on half-typed code.  It blanks out
 * comments and string literals (keeping offsets aligned) and then picks out
 * declarations line by line, tracking which procedure, structure or module each
 * symbol belongs to.
 *
 * PureBasic's surface is not FreeBASIC's: one `Procedure` keyword rather than
 * sub/function, `*ptr` and `name$` where the sigil is part of the name, `.type`
 * suffixes, `\` for member access, 20-odd folding blocks, and `;` as the only
 * comment.  Those differences are the whole of this file.
 */
import type { PbDocument, PbPosition, PbSymbol, PbSymbolKind } from './types.ts';

/** The blocks whose bodies this scanner tracks. */
type BlockKind =
	| 'procedure'
	| 'structure'
	| 'structureunion'
	| 'interface'
	| 'module'
	| 'declaremodule'
	| 'enumeration'
	| 'macro'
	| 'datasection'
	| 'import';

/** Replace comments and string literals with spaces, preserving offsets. */
export function maskSource(text: string): string[] {
	const lines = text.split(/\r\n|\r|\n/);
	const out: string[] = [];

	for (const line of lines) {
		// an inline-assembly line is not PureBasic at all
		if (/^\s*!/.test(line)) {
			out.push(' '.repeat(line.length));
			continue;
		}

		let masked = '';
		let i = 0;
		while (i < line.length) {
			const ch = line[i]!;

			// ';' starts a comment, and PureBasic has no block comment
			if (ch === ';') {
				masked += ' '.repeat(line.length - i);
				break;
			}

			// ~"..." is the escape string, where \" is a quote
			if (ch === '~' && line[i + 1] === '"') {
				masked += '  ';
				i += 2;
				while (i < line.length) {
					if (line[i] === '\\' && line[i + 1] === '"') {
						masked += '  ';
						i += 2;
						continue;
					}
					if (line[i] === '"') {
						masked += ' ';
						i++;
						break;
					}
					masked += ' ';
					i++;
				}
				continue;
			}

			// "..." has no escape of its own (that is what ~ strings are for)
			if (ch === '"') {
				masked += ' ';
				i++;
				while (i < line.length) {
					if (line[i] === '"') {
						masked += ' ';
						i++;
						break;
					}
					masked += ' ';
					i++;
				}
				continue;
			}

			masked += ch;
			i++;
		}
		out.push(masked);
	}

	return out;
}

/** Comment lines directly above a declaration become its documentation. */
function docAbove(lines: string[], index: number): string | undefined {
	const parts: string[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		if (line === '') break;
		if (line.startsWith(';')) {
			parts.unshift(line.replace(/^;\s?/, ''));
			continue;
		}
		break;
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Extract "x.d, *p, name$" from the parentheses of a declaration line. */
function paramListOf(sourceLine: string): string | undefined {
	const open = sourceLine.indexOf('(');
	if (open < 0) return undefined;
	let depth = 0;
	for (let i = open; i < sourceLine.length; i++) {
		const ch = sourceLine[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return sourceLine.slice(open + 1, i).trim();
		}
	}
	return sourceLine.slice(open + 1).trim();
}

/** Parameter names from a parameter list, sigils and types included. */
export function parameterNames(params: string | undefined): string[] {
	if (!params) return [];
	const names: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of params) {
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		if (ch === ',' && depth === 0) {
			names.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	names.push(current);

	return names
		.map((p) => {
			const m = p.trim().match(/^(\*?)\s*([A-Za-z_]\w*\$?)/);
			return m ? `${m[1]}${m[2]}` : '';
		})
		.filter((n) => n.length > 0);
}

/** The `.type` suffix a name carries, e.g. "x.d" -> "d". */
function typeSuffixOf(text: string): string | undefined {
	const m = text.match(/\.([A-Za-z_][A-Za-z0-9_]*)/);
	return m ? m[1] : undefined;
}

/** Split a declarator list on the commas that are not inside brackets. */
function splitDeclarators(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of text) {
		if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		if (ch === ',' && depth <= 0) {
			out.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	out.push(current);
	return out;
}

/** One declarator list, read down to the names it declares. */
function collectDeclarators(
	text: string,
	suffix: string | undefined,
): { name: string; type?: string }[] {
	const names: { name: string; type?: string }[] = [];
	for (const declarator of splitDeclarators(text)) {
		const m = /^\s*(\*?[A-Za-z_]\w*\$?)/.exec(declarator);
		if (!m) continue;
		names.push({ name: m[1]!, type: typeSuffixOf(declarator) ?? suffix });
	}
	return names;
}

/** `Dim a(10), b.s` / `Define.q x, y` -> the names being declared. */
export function declaredNames(
	line: string,
): { names: { name: string; type?: string }[]; kind: PbSymbolKind } | undefined {
	const dim =
		/^\s*(?:(?:global|protected|static|threaded)\s+)?(?:dim|redim)\b\s*(?:\.([A-Za-z_]\w*))?\s*(.+)$/i.exec(
			line,
		);
	if (dim) return { names: collectDeclarators(dim[2]!, dim[1]), kind: 'array' };

	const scope =
		/^\s*(?:global\s+|protected\s+|static\s+|threaded\s+|shared\s+|define\b\s*(?:\.([A-Za-z_]\w*))?\s*)+(.+)$/i;
	const scoped = scope.exec(line);
	if (scoped) return { names: collectDeclarators(scoped[2]!, scoped[1]), kind: 'variable' };

	return undefined;
}

/* ------------------------------------------------------------------ parsing */

const PROC_RE =
	/^\s*(runtime\s+)?(procedure|proceduredll|procedurec|procedurecdll|declare|declaredll|declarec|declarecdll|prototype|prototypec)\s*(?:\.([A-Za-z_]\w*))?\s+(\*?[A-Za-z_]\w*)/i;

const OPEN_RE =
	/^\s*(structureunion|structure|interface|declaremodule|module|macro|datasection|importc|import|enumerationbinary|enumeration)\b\s*(?:\.([A-Za-z_]\w*))?\s*([A-Za-z_]\w*)?/i;

const CLOSE_RE = /^\s*(endprocedure|endstructureunion|endstructure|endinterface|enddeclaremodule|endmodule|endmacro|enddatasection|endimport|endenumeration)\b/i;

// matched against the masked text (where the quoted path is blank), so the
// directive alone is what is found here; the path comes from the source line
const INCLUDE_RE = /\b(?:xinclude|include)\s*file\b/gi;
const INCLUDE_PATH_RE = /\b(?:xinclude|include)\s*file\s+"([^"]+)"/i;
/** `IncludePath "dir"`, the search path the compiler adds while including. */
const INCLUDE_DIR_RE = /^\s*include\s*path\s+"([^"]+)"/i;

const CONST_RE = /^\s*(#[A-Za-z_]\w*\$?)\s*(?:=|\+)/;
const NEWCONTAINER_RE =
	/^\s*(?:(?:global|protected|static|threaded)\s+)?(newlist|newmap)\b\s*[A-Za-z_]\w*\s*(?:\.([A-Za-z_]\w*))?\s*\(/i;
/*
 * Directives that can sit between structure fields.  Each is matched as a whole
 * keyword, because a field may be named anything: `ImportedDllName$` is a field
 * and not an `Import`, and the compiler accepts it (checked with pbcompiler).
 */
const FIELD_IGNORE_RE =
	/^(?:Compiler(?:If|ElseIf|Else|EndIf|Select|Case|Default|EndSelect|Error|Warning)\b|ImportC?\b|Data\b)/i;

/** Field-shaped lines that are really block markers or modifiers. */
const FIELD_RESERVED_RE =
	/^(?:EndStructure|EndStructureUnion|EndInterface|Structure|StructureUnion|Interface|Extends|Align|Static)\b|^(?:List|Array|Map)$/i;

/**
 * `x.MyStruct`, `*p.MyStruct` or `x.i` on a line of its own: the bare form is a
 * declaration too -- pbcompiler accepts it -- and it is how a structured
 * variable is usually introduced.
 */
const BARE_DECL_RE = /^\s*(\*?[A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*$/;

const FIELD_RE =
	/^\s*(?:(list|array|map)\s+)?(\*?[A-Za-z_]\w*\$?)(?:\.([A-Za-z_]\w*))?(?:\s*(?:\[\s*\w+\s*\]|\([^)]*\)))?\s*$/i;
const LABEL_RE = /^\s*([A-Za-z_]\w*)\s*:(?!:)/;
const ASSIGN_RE = /^\s*(\*?[A-Za-z_]\w*\$?)\s*=[^=]/;
const FOR_RE = /^\s*(foreach|for)\b\s*(\*?[A-Za-z_]\w*\$?)/i;

const CLOSE_KIND: Record<string, BlockKind | 'structureunion' | 'enumeration'> = {
	endprocedure: 'procedure',
	endstructure: 'structure',
	endstructureunion: 'structureunion',
	endinterface: 'interface',
	endmodule: 'module',
	enddeclaremodule: 'declaremodule',
	endmacro: 'macro',
	enddatasection: 'datasection',
	endimport: 'import',
	endenumeration: 'enumeration',
};

const OPEN_KIND: Record<string, BlockKind> = {
	procedure: 'procedure',
	proceduredll: 'procedure',
	procedurec: 'procedure',
	procedurecdll: 'procedure',
	structure: 'structure',
	structureunion: 'structureunion',
	interface: 'interface',
	module: 'module',
	declaremodule: 'declaremodule',
	macro: 'macro',
	datasection: 'datasection',
	import: 'import',
	importc: 'import',
	enumeration: 'enumeration',
	enumerationbinary: 'enumeration',
};

/** Scan one document. */
export function parseDocument(uri: string, text: string): PbDocument {
	const lines = text.split(/\r\n|\r|\n/);
	const masked = maskSource(text);
	const symbols: PbSymbol[] = [];
	const includes: string[] = [];
	const includePaths: string[] = [];

	// The blocks we are inside, outermost first.
	const stack: { kind: BlockKind; name: string; symbol?: PbSymbol }[] = [];

	const scopeOf = (): string => {
		for (let i = stack.length - 1; i >= 0; i--) {
			const block = stack[i]!;
			if (block.kind === 'procedure') return block.name;
			if (block.kind === 'structure' || block.kind === 'structureunion' || block.kind === 'interface') {
				return block.name;
			}
		}
		return '';
	};

	const add = (
		name: string,
		kind: PbSymbolKind,
		lineIndex: number,
		detail: string,
		extra: Partial<PbSymbol> = {},
	): PbSymbol => {
		const symbol: PbSymbol = {
			name,
			kind,
			line: lineIndex,
			detail: detail.trim(),
			scope: scopeOf(),
			file: uri,
			doc: docAbove(lines, lineIndex),
			...extra,
		};
		symbols.push(symbol);
		return symbol;
	};

	/** The body we are directly inside, if any. */
	const inside = (kind: BlockKind): boolean => stack.some((b) => b.kind === kind);

	for (let i = 0; i < masked.length; i++) {
		const line = masked[i]!;
		const source = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === '') continue;

		// IncludeFile / XIncludeFile anywhere on the line; read the path from the
		// original text, since masking blanks the quoted string.
		INCLUDE_RE.lastIndex = 0;
		let inc: RegExpExecArray | null;
		while ((inc = INCLUDE_RE.exec(line)) !== null) {
			const found = INCLUDE_PATH_RE.exec(source.slice(inc.index));
			if (found) includes.push(found[1]!);
		}

		// IncludePath "dir": adds a directory to the search path for the includes
		// that follow it, which is how a project keeps its sources in a tree.
		const dir = INCLUDE_DIR_RE.exec(source);
		if (dir) includePaths.push(dir[1]!);

		// a block terminator
		const close = CLOSE_RE.exec(line);
		if (close) {
			const word = close[1]!.toLowerCase();
			const wanted = CLOSE_KIND[word];
			for (let s = stack.length - 1; s >= 0; s--) {
				const block = stack[s]!;
				const matches =
					block.kind === wanted ||
					(wanted === 'structure' && block.kind === 'structureunion') ||
					(wanted === 'enumeration' &&
						(block.kind === 'enumeration' || block.kind === 'declaremodule'));
				if (matches) {
					if (block.kind === 'procedure' && block.symbol) block.symbol.endLine = i;
					stack.splice(s, 1);
					break;
				}
			}
			continue;
		}

		// Procedure[.type] Name(params) / Declare* / Prototype*
		const proc = PROC_RE.exec(line);
		if (proc) {
			const keyword = proc[2]!.toLowerCase();
			const isProto = keyword.startsWith('declare') || keyword.startsWith('prototype');
			const name = proc[4]!;
			const params = paramListOf(source);
			const symbol = add(name, isProto ? 'declare' : 'procedure', i, source, {
				params,
				returns: proc[3],
				pointer: name.startsWith('*') || undefined,
			});
			// Only a real definition opens a body, and only when it does not close
			// on the same line.
			const bodyOnSameLine = /\bendprocedure\b/i.test(line);
			if (!isProto && !bodyOnSameLine) {
				stack.push({ kind: 'procedure', name, symbol });
			}
			continue;
		}

		// Structure / Interface / Module / Macro / DataSection / Import / Enumeration
		const open = OPEN_RE.exec(line);
		if (open) {
			const keyword = open[1]!.toLowerCase();
			const kind = OPEN_KIND[keyword]!;
			const name = open[3] ?? '';
			let symbol: PbSymbol | undefined;
			if (name !== '') {
				symbol = add(
					name,
					kind === 'enumeration'
						? 'enumeration'
						: (kind as PbSymbolKind),
					i,
					source,
					{ type: open[2] },
				);
			}
			// a structure union has no name of its own: its fields belong to the
			// structure around it
			const scopeName = name !== '' ? name : (stack.filter((b) => b.kind === 'structure').pop()?.name ?? '');
			if (!new RegExp(`\\bend${keyword}\\b`, 'i').test(line)) {
				stack.push({ kind, name: kind === 'structureunion' ? scopeName : name, symbol });
			}
			continue;
		}

		// enumeration members are module-level constants
		if (stack.length > 0 && stack[stack.length - 1]!.kind === 'enumeration') {
			const member = /^\s*(#?)([A-Za-z_]\w*)\s*(?:=\s*(.+))?$/.exec(trimmed);
			if (member && !/^(Case|Default)$/i.test(member[2]!)) {
				add(member[2]!, 'enummember', i, source, { detail: source.trim() });
				continue;
			}
		}

		// structure / interface fields
		const structIndex = [...stack].reverse().findIndex(
			(b) => b.kind === 'structure' || b.kind === 'structureunion' || b.kind === 'interface',
		);
		if (structIndex >= 0 && !FIELD_IGNORE_RE.test(trimmed)) {
			const scopeBlock = stack[stack.length - 1 - structIndex]!;
			if (scopeBlock.kind !== 'enumeration') {
				const field = FIELD_RE.exec(trimmed);
				if (field && !FIELD_RESERVED_RE.test(trimmed) && !/^\*?\w+\s*\(/.test(trimmed)) {
					add(field[2]!, 'field', i, source, {
						type: field[3],
						pointer: field[2]!.startsWith('*') || undefined,
						container: field[1]?.toLowerCase() as 'list' | 'map' | 'array' | undefined,
					});
					continue;
				}
			}
		}

		// #Constant = value
		const constant = CONST_RE.exec(line);
		if (constant) {
			add(constant[1]!, 'constant', i, source, { detail: source.trim() });
			continue;
		}

		// NewList / NewMap
		const container = NEWCONTAINER_RE.exec(line);
		if (container) {
			const name = /^\s*(?:(?:global|protected|static|threaded)\s+)?(?:newlist|newmap)\b\s*([A-Za-z_]\w*)/i.exec(
				line,
			);
			if (name) {
				add(name[1]!, container[1]!.toLowerCase() === 'newlist' ? 'list' : 'map', i, source, {
					type: container[2],
					detail: source.trim(),
				});
				continue;
			}
		}

		// Dim / Define / Global / Protected / Static / Threaded / Shared
		const declared = declaredNames(line);
		if (declared) {
			for (const entry of declared.names) {
				add(entry.name, declared.kind, i, source, {
					type: entry.type,
					pointer: entry.name.startsWith('*') || undefined,
					detail: source.trim(),
				});
			}
			continue;
		}

		// a bare `name.Type` declaration, which pbcompiler accepts on its own
		const typed = inside('datasection') ? null : BARE_DECL_RE.exec(line);
		if (typed) {
			add(typed[1]!, 'variable', i, source, {
				type: typed[2],
				pointer: typed[1]!.startsWith('*') || undefined,
				detail: source.trim(),
			});
			continue;
		}

		// a For / ForEach counter is a variable too
		const loop = FOR_RE.exec(line);
		if (loop) {
			add(loop[2]!, 'variable', i, source, { detail: source.trim() });
			continue;
		}

		// an assignment creates the variable on first use
		const assign = ASSIGN_RE.exec(line);
		if (assign && !inside('datasection')) {
			add(assign[1]!, 'variable', i, source, { detail: source.trim() });
			continue;
		}

		// a label: Name:
		const label = LABEL_RE.exec(line);
		if (label && !/^(Case|Default|Data|CompilerCase|CompilerDefault)$/i.test(label[1]!)) {
			add(label[1]!, 'label', i, source);
			continue;
		}
	}

	return { uri, text, symbols, includes, includePaths };
}

/**
 * The word ending just before `end` (exclusive), if there is one.
 *
 * A character typed at the caret finishes the word to its left, which is what
 * the auto-capitalisation looks at.
 */
export function wordBefore(
	text: string,
	end: number,
): { word: string; start: number; end: number } | undefined {
	let start = Math.max(0, Math.min(end, text.length));
	while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1]!)) start--;
	if (start >= end) return undefined;
	return { word: text.slice(start, end), start, end };
}

/* ------------------------------------------------------------- cursor views */

/** The identifier at a position, with its range and any leading sigil. */
export function wordAt(
	text: string,
	position: PbPosition,
): { word: string; startChar: number; endChar: number; line: string } | undefined {
	const lines = text.split(/\r\n|\r|\n/);
	const line = lines[position.line];
	if (line === undefined) return undefined;

	let start = position.character;
	let end = position.character;
	const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);

	while (start > 0 && isWord(line[start - 1]!)) start--;
	while (end < line.length && isWord(line[end]!)) end++;
	// the sigils PureBasic treats as part of a name
	if (start > 0 && /[*@?#]/.test(line[start - 1]!)) start--;

	const word = line.slice(start, end);
	if (word.length === 0) return undefined;
	return { word, startChar: start, endChar: end, line };
}

/** What the character before the cursor is asking for. */
export function memberContextAt(
	text: string,
	position: PbPosition,
	word = '',
): 'type' | 'member' | 'plain' {
	const lines = maskSource(text);
	const line = lines[position.line] ?? '';
	const before = line.slice(0, Math.max(0, position.character - word.length));
	if (/\.\s*$/.test(before)) return 'type';
	if (/\\\s*$/.test(before)) return 'member';
	return 'plain';
}

/** Where the cursor sits in a statement, which decides what may be offered. */
export type PbStatementKind = 'start' | 'expression';

export function statementContextAt(
	text: string,
	position: PbPosition,
	word = '',
): { kind: PbStatementKind; before: string } {
	const line = maskSource(text)[position.line] ?? '';
	const upto = line.slice(0, Math.max(0, position.character - word.length));
	// ':' starts a new statement on the same line
	const colon = upto.lastIndexOf(':');
	// but '::' is the module separator, and a label colon is not a statement split
	const before = colon >= 0 && upto[colon - 1] !== ':' && upto[colon + 1] !== ':' ? upto.slice(colon + 1) : upto;
	const trimmed = before.trim();

	if (trimmed === '') return { kind: 'start', before };
	if (/(?:[=+\-*/%&|<>(),]|\b(?:And|Or|Not|Xor|To|Step|Mod))\s*$/i.test(trimmed)) {
		return { kind: 'expression', before };
	}
	return { kind: 'start', before };
}

/**
 * If the position is inside a call's argument list, return the callee and the
 * zero-based index of the argument being typed (used for signature help).
 */
export function callContextAt(
	text: string,
	position: PbPosition,
): { callee: string; activeParameter: number } | undefined {
	const masked = maskSource(text);
	const line = masked[position.line];
	if (line === undefined) return undefined;

	let depth = 0;
	let lineIndex = position.line;
	let charIndex = position.character;

	for (; lineIndex >= 0; lineIndex--) {
		const current = masked[lineIndex]!;
		if (charIndex > current.length) charIndex = current.length;
		for (let i = charIndex - 1; i >= 0; i--) {
			const ch = current[i]!;
			if (ch === ')') depth++;
			else if (ch === '(') {
				if (depth === 0) {
					let s = i;
					while (s > 0 && /[A-Za-z0-9_:$]/.test(current[s - 1]!)) s--;
					const callee = current.slice(s, i);
					if (!callee) return undefined;

					let commas = 0;
					let d = 0;
					for (let li = lineIndex; li <= position.line; li++) {
						const l = masked[li]!;
						const from = li === lineIndex ? i + 1 : 0;
						const to = li === position.line ? position.character : l.length;
						for (let k = from; k < to; k++) {
							const c = l[k]!;
							if (c === '(' || c === '[') d++;
							else if (c === ')' || c === ']') d--;
							else if (c === ',' && d === 0) commas++;
						}
					}
					return { callee, activeParameter: commas };
				}
				depth--;
			}
		}
		charIndex = lineIndex > 0 ? masked[lineIndex - 1]!.length : 0;
	}

	return undefined;
}
