/*
 * A small in-memory symbol index over the open document plus (optionally) the
 * rest of the workspace.
 */
import { parseDocument } from './parser.ts';
import type { PbDocument } from './types.ts';

export class PbIndex {
	private documents = new Map<string, PbDocument>();
	private limit: number;

	constructor(limit = 400) {
		this.limit = limit;
	}

	/** Parse and store a document. Returns the parsed document. */
	index(uri: string, text: string): PbDocument {
		const document = parseDocument(uri, text);
		this.documents.delete(uri);
		this.documents.set(uri, document);
		this.trim();
		return document;
	}

	remove(uri: string): void {
		this.documents.delete(uri);
	}

	get(uri: string): PbDocument | undefined {
		return this.documents.get(uri);
	}

	clear(): void {
		this.documents.clear();
	}

	uris(): string[] {
		return [...this.documents.keys()];
	}

	stats(): { files: number; symbols: number; limit: number } {
		let symbols = 0;
		for (const doc of this.documents.values()) symbols += doc.symbols.length;
		return { files: this.documents.size, symbols, limit: this.limit };
	}

	/** Keep the index bounded: drop the least recently indexed documents. */
	private trim(): void {
		while (this.documents.size > this.limit) {
			const oldest = this.documents.keys().next();
			if (oldest.done) break;
			this.documents.delete(oldest.value);
		}
	}
}
