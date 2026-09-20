import type { PbDocument, PbSymbol } from './types.ts';

export interface DocumentPool {
	uris(): readonly string[];
	get(uri: string): PbDocument | undefined;
}

function schemeOf(uri: string): string {
	const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(uri);
	return match ? match[0] : '';
}

export function pathOfUri(uri: string): string {
	const path = uri.slice(schemeOf(uri).length);
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export function dirOfPath(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut <= 0 ? '/' : path.slice(0, cut);
}

export function baseNameOf(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

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

export function uriForPath(pool: DocumentPool, path: string): string | undefined {
	const wanted = path.toLowerCase();
	for (const uri of pool.uris()) {
		if (pathOfUri(uri).toLowerCase() === wanted) return uri;
	}
	return undefined;
}

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
