/*
 * Which files may contribute symbols to which.
 *
 * PureBasic compiles one translation unit: a procedure in another file is only
 * visible when the compiler was told to pull that file in, with IncludeFile or
 * XIncludeFile -- and the pull is transitive, because a file included by an
 * included file lands in the same unit.  The editor works file by file instead,
 * so this graph is what decides which files may reference each other.
 *
 * Directions are followed both ways.  A file that is included by a main file is
 * part of that main file's program, so while it is being edited the symbols of
 * the whole group are offered: in a chain A -> B -> C, A, B and C all suggest
 * each other's symbols.
 *
 * Verified against pbcompiler 6.41: a nested include resolves relative to the
 * file that writes the statement (not the root file), and an IncludePath is
 * relative to the file that declares it.
 */
import type { PbDocument, PbSymbol } from './types.ts';

/** The documents the include graph is built from. */
export interface DocumentPool {
	uris(): readonly string[];
	get(uri: string): PbDocument | undefined;
}

/** The `file://` style prefix of a uri, or '' when there is none. */
function schemeOf(uri: string): string {
	const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(uri);
	return match ? match[0] : '';
}

/**
 * The absolute path a uri points at, decoded.  Include targets are written the
 * way they appear on disk, so a folder with a space has to compare equal to the
 * `%20` the editor puts in a uri.
 */
export function pathOfUri(uri: string): string {
	const path = uri.slice(schemeOf(uri).length);
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/** The directory holding a path. */
export function dirOfPath(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut <= 0 ? '/' : path.slice(0, cut);
}

/** The file name part of a path, whichever separator it uses. */
export function baseNameOf(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

/** `.` and `..` resolved, single slashes, no trailing slash. */
function normalizePath(path: string): string {
	const out: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			out.pop();
			continue;
		}
		out.push(part);
	}
	return `/${out.join('/')}`;
}

/**
 * The paths an include target may name, in the order the compiler tries them:
 * relative to the file that writes the statement, then the IncludePath
 * directories.  An absolute target is used as written.
 */
export function resolveIncludeTargets(
	fromPath: string,
	target: string,
	searchPaths: readonly string[] = [],
): string[] {
	const wanted = target.trim().replace(/\\/g, '/');
	if (wanted === '') return [];
	if (wanted.startsWith('/') || /^[a-z]:\//i.test(wanted)) {
		return [normalizePath(wanted.startsWith('/') ? wanted : `/${wanted}`)];
	}

	const candidates = [normalizePath(`${dirOfPath(fromPath)}/${wanted}`)];
	for (const search of searchPaths) candidates.push(normalizePath(`${search}/${wanted}`));
	return candidates;
}

/** Every IncludePath directory the pool declares, as absolute paths. */
export function includeSearchPaths(pool: DocumentPool): string[] {
	const out = new Set<string>();
	for (const uri of pool.uris()) {
		const document = pool.get(uri);
		for (const declared of document?.includePaths ?? []) {
			const [first] = resolveIncludeTargets(pathOfUri(uri), declared);
			if (first !== undefined) out.add(first);
		}
	}
	return [...out];
}

/** The pool's uri for a path, ignoring case, as macOS and Windows do. */
export function uriForPath(pool: DocumentPool, path: string): string | undefined {
	const wanted = path.toLowerCase();
	for (const uri of pool.uris()) {
		if (pathOfUri(uri).toLowerCase() === wanted) return uri;
	}
	return undefined;
}

/**
 * Every file that shares a translation unit with `root`: what it includes, what
 * includes it, and so on through the chain in either direction.  Bounded by
 * `limit` so a pathological project cannot make a completion request walk the
 * whole disk.
 */
export function includeGroup(root: string, pool: DocumentPool, limit = 400): Set<string> {
	const searchPaths = includeSearchPaths(pool);
	const neighbours = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		let set = neighbours.get(a);
		if (!set) {
			set = new Set<string>();
			neighbours.set(a, set);
		}
		set.add(b);
	};

	for (const uri of pool.uris()) {
		const document = pool.get(uri);
		for (const target of document?.includes ?? []) {
			for (const candidate of resolveIncludeTargets(pathOfUri(uri), target, searchPaths)) {
				const found = uriForPath(pool, candidate);
				if (found === undefined || found === uri) continue;
				link(uri, found);
				link(found, uri);
				break;
			}
		}
	}

	const group = new Set<string>([root]);
	const queue: string[] = [root];
	while (queue.length > 0 && group.size < limit) {
		const current = queue.shift()!;
		for (const next of neighbours.get(current) ?? []) {
			if (group.has(next)) continue;
			group.add(next);
			queue.push(next);
		}
	}
	return group;
}

/**
 * What the files of a group contribute to the document being completed in:
 * module-level names always, and fields as well, because a structure used across
 * files needs its members after a `\`.  Fields never show up as ordinary
 * completions -- buildCompletions only reaches for them in a member context --
 * and the document itself is left out, since its own symbols are already there.
 */
export function groupSymbols(
	group: Iterable<string>,
	pool: DocumentPool,
	excludeUri?: string,
): PbSymbol[] {
	const out: PbSymbol[] = [];
	for (const uri of group) {
		if (uri === excludeUri) continue;
		const document = pool.get(uri);
		if (!document) continue;
		for (const symbol of document.symbols) {
			if (symbol.scope === '' || symbol.kind === 'field') out.push(symbol);
		}
	}
	return out;
}
