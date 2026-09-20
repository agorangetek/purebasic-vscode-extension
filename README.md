# PureBasic Language Support

PureBasic language support for Visual Studio Code: syntax highlighting, code
completion, hovers, signature help and a document outline.

It uses the same architecture as the [FreeBASIC
extension](https://github.com/agorangetek/freebasic-vscode-extension): plain
VS Code providers, running in-process. There is **no language server** — no
second process, no IPC, nothing to restart.

## Features

### Syntax highlighting

A TextMate grammar generated from the PureBasic IDE's own keyword and command
tables: keywords by category, library commands per library
(`support.function.gadget.purebasic`, …), `#Constants`, `*pointers`, `@proc`
addresses, `?data` labels, `var\field` members, `Module::item`, `.type`
suffixes, `~"escape strings"` and `!` inline assembly. PureBasic's single
comment (`;`) and its two string forms are scoped, so a keyword written inside
a string stays a string.

Folding, bracket matching and indentation come from the IDE's folding-pair
table — all 25 blocks, including `Repeat … Until` **or** `Forever`.

### Code completion

* **1888 library commands** with the manual's signature and library, generated
  from the PureBasic IDE's command database — `MessageRequester`, `AddElement`,
  `OpenFile`, each with its parameter list taken apart so call snippets can be
  inserted: `MessageRequester(${1:Title}, ${2:Text}, …)`.
* **111 keywords** in their canonical spelling (`EndProcedure`, `ReDim`,
  `ForEach`, `CompilerEndIf`).
* **Your own symbols** — procedures, structures, interfaces, modules,
  enumerations, macros, constants, `NewList`/`NewMap` containers, fields,
  arrays, labels and parameters, indexed from the current file and (optionally)
  from every `.pb`/`.pbi` file in the workspace.
* **Blocks that close themselves** — accepting `Procedure`, `Structure`,
  `Module`, `If`, `Select`, `ForEach`, `Repeat`, `CompilerIf`, … at the start of
  a statement inserts the whole skeleton with its terminator.
* **Type awareness** — after a `.` you get the built-in type suffixes (`.i`,
  `.d`, `.s`, …) with what each one means, plus every structure and interface in
  the workspace; after a `\` you get structure members.
* **Prefix filtering, in any case** — typing a character offers only the names
  that *start* with it, whatever case you type.

### Hover and signature help

Hovering a command shows the manual's signature, the library it belongs to and
its category; hovering your own symbols shows their declaration and the comment
above them. Inside a call, the signature help widget highlights the parameter
you are on and marks the optional ones.

### Format Text — canonical case

PureBasic is case-insensitive, so the extension will fix the spelling for you:
`PureBasic: Format Text (Canonical Case)` is on the editor context menu, in the
command palette, and registered as the formatter for *Format Document* /
*Format Selection*.

It restores what the language provides — `endprocedure` → `EndProcedure`,
`redim` → `ReDim`, `foreach` → `ForEach`, `messagerequester` →
`MessageRequester` — and leaves your own identifiers byte for byte, sigils
included (`*pBuffer`, `name$`, `MyProc`, `Point`). Comments and string literals
are never touched, line endings are preserved, and running it twice changes
nothing the second time.

### Outline

`Go to Symbol` lists procedures, structures, interfaces, modules, enumerations,
macros, constants and labels. With `purebasic.index.workspace` enabled,
symbols from every `.pb`/`.pbi` file in the workspace are completed across
files.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `purebasic.completion.enable` | `true` | Master switch for completion. |
| `purebasic.completion.keywords` | `true` | Offer language keywords. |
| `purebasic.completion.builtins` | `true` | Offer built-in library commands. |
| `purebasic.completion.snippets` | `true` | Insert call snippets with parameter placeholders. |
| `purebasic.index.workspace` | `true` | Index `.pb`/`.pbi` files across the workspace. |
| `purebasic.index.maxFiles` | `400` | Cap on indexed workspace files. |
| `purebasic.format.canonicalCase` | `true` | Restore canonical spelling when formatting. |
| `purebasic.trace.server` | `"off"` | Log language service activity to the *PureBasic* output channel. |

## Commands

* **PureBasic: Rebuild Symbol Index** (`purebasic.reindex`) — re-scan the workspace.
* **PureBasic: Show Symbol Index Statistics** (`purebasic.showIndexStats`) — how
  many files and symbols were indexed.
* **PureBasic: Format Text (Canonical Case)** (`purebasic.formatText`) — restore
  canonical spelling in the selection, or in the whole file.

## How it is put together

```
src/extension.ts    the only file that imports 'vscode'; translates between
                    the editor API and plain objects
src/service/        the language service: parser, completion, hover, signature,
                    casing, blocks, index. No 'vscode' import, so it is tested
                    with plain node
syntaxes/           the generated TextMate grammar
src/data/           the generated keyword and command database
tools/              the two generators
```

Because `src/service/` never imports `vscode`, the whole language service runs
under `node --test`. If an LSP wrapper is ever wanted, this layer becomes the
server's core unchanged.

## Building from source

```sh
npm install
npm run check     # typecheck + unit tests + bundle
npm run package   # produces purebasic-<version>.vsix
```

The keyword and command database is generated from a PureBasic IDE checkout and
committed to `src/data/`; the grammar is generated from that database and
committed to `syntaxes/`. To refresh both:

```sh
node tools/gen-data.mjs "/path/to/PB IDE"   # or set PB_IDE
npm run gen-grammar
```

`tools/gen-data.mjs` reads `scripts/commands/pb_commands_full.json` (every
command, with the manual's signature and library) and
`scripts/PureBasicKeywords.gd` (the reserved words, their canonical spelling,
the folding pairs and the type suffixes). The grammar's word lists come from
the result, so highlighting and completion can never drift apart.

The language service is written in "erasable syntax only" TypeScript (no enums,
no parameter properties), so node can run the `.ts` sources directly. `npm test`
passes `--experimental-strip-types`, so it works on Node 22.6 and newer.

## Requirements

PureBasic 6.x. The extension does not ship or invoke the compiler — it is a
language service only.

## Known limitations

* No diagnostics; `pbcompiler` is not run in the background.
* No go-to-definition, references or rename yet.
* Workspace indexing is capped (`purebasic.index.maxFiles`) and re-runs on demand.
* Only the text form of `.pbf` form files is treated as PureBasic.
