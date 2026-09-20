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

#### Scopes, and re-colouring anything

The scopes are the conventional TextMate ones, so a theme colours PureBasic the
way it colours anything else — no per-language configuration needed. Every
scope below is specific to PureBasic:

| what | scope |
| --- | --- |
| keywords (`Procedure`, `EndProcedure`, `ReDim`, `If`, …) | `keyword.control.purebasic` |
| declaration keywords (`Dim`, `Global`, `NewList`, …) | `keyword.other.purebasic` |
| compiler directives and includes (`CompilerIf`, `IncludeFile`, `Macro`) | `meta.preprocessor.purebasic` |
| operators, words and symbols (`And`, `=`, `<=`) | `keyword.operator.purebasic` |
| procedures, declared and called | `entity.name.function.purebasic` |
| structures, interfaces, modules (declared) | `entity.name.type.purebasic` |
| a type name after a `.` (used) | `entity.name.type.reference.purebasic` |
| a native type suffix or return type (`.d`, `.i`) | `storage.type.purebasic` |
| library commands (`MessageRequester`, …) | `support.function.purebasic` |
| constants (`#MaxPoints`, `#PB_Event_CloseWindow`) | `constant.other.predefined.purebasic` |
| `True` / `False`, `Null` | `constant.language.boolean\|null.purebasic` |
| numbers (`12`, `$FF`, `%1010`, `1.5`) | `constant.numeric.decimal\|hex\|bin\|float.purebasic` |
| pointers (`*pBuffer`) | `constant.other.pointer.purebasic` |
| structure members, read (`pt\x`, `obj\map()`) | `variable.other.member.purebasic` |
| a name taking a type (`test.my_test`, `name.s`) | `variable.other.typed.purebasic` |
| a module prefix (`Helper::DoIt`) | `entity.name.namespace.purebasic` |
| a procedure address (`@MyProc`) | `constant.other.reference.purebasic` (bare `@` too) |
| a data label (`?data`) | `variable.other.label-reference.purebasic` |
| labels (`top:`) | `entity.name.label.purebasic` |
| a statement separator (`:`) | `punctuation.separator.statement.purebasic` |
| inline assembly (`! mov …`) | `meta.embedded.asm.purebasic` |

The scope vocabulary follows [duty1g/vscode-purebasic](https://github.com/duty1g/vscode-purebasic) (MIT).

Colours come from the theme: the grammar emits only standard TextMate scopes, so switching
theme switches them and nothing is pinned. If you want the PureBasic IDE's own Monokai scheme
whatever theme you run, paste the rules from
[docs/purebasic-ide-monokai.jsonc](docs/purebasic-ide-monokai.jsonc) into
`editor.tokenColorCustomizations.textMateRules` -- they name every scope the grammar emits, so
nothing is left half-coloured. Any customisation you add overrides the theme for the scopes it
names, which is how VS Code layers them.

A library's name is used as-is, except the String library, whose segment is `stringlib`.
VS Code reads the suggestions category of the token under the caret from its innermost
scope with `/\b(comment|string|regex|regexp)\b/`; a bare `string` segment would make it
treat a command as a string literal, and typing it would never pop up the list.

To colour one of them differently, target it from your settings:

```jsonc
"editor.tokenColorCustomizations": {
    "textMateRules": [
        {
            "scope": [
                "source.purebasic storage.type.purebasic",
                "source.purebasic entity.name.type.purebasic"
            ],
            "settings": { "foreground": "#9CDCFE" }
        }
    ]
}
```

Note the `source.purebasic` prefix — it keeps the rule to this language.
Wrapping the setting in a `"[purebasic]"` block does **not** work for token
colours; it is silently ignored.

The type scopes are worth singling out, because the default dark theme is
inconsistent about them: `storage.type` falls through to the base theme's
classic blue (`#569CD6`, the same colour as a keyword), while
`entity.name.type` is dark_plus's teal (`#4EC9B0`). The example above makes
both a lighter blue (`#9CDCFE`) so a type reads as a type rather than as
another keyword.

### Code completion

* **1888 library commands** with the manual's signature and library, generated
  from the PureBasic IDE's command database — `MessageRequester`, `AddElement`,
  `OpenFile`, each with its parameter list taken apart so call snippets can be
  inserted: `MessageRequester(${1:Title}, ${2:Text}, …)`.
* **111 keywords** in their canonical spelling (`EndProcedure`, `ReDim`,
  `ForEach`, `CompilerEndIf`).
* **Your own symbols** — procedures, structures, interfaces, modules,
  enumerations, macros, constants, `NewList`/`NewMap` containers, fields,
  arrays, labels and parameters, from the current file and from the files the
  current one is joined to by `IncludeFile`/`XIncludeFile` (see below).
* **Blocks that close themselves** — accepting `Procedure`, `Structure`,
  `Module`, `If`, `Select`, `ForEach`, `Repeat`, `CompilerIf`, … at the start of
  a statement inserts the whole skeleton with its terminator.
* **Type awareness** — after a `.` you get the built-in type suffixes (`.i`,
  `.d`, `.s`, …) with what each one means, plus every structure and interface in
  the include group; after a `\` you get structure members.
* **List, Map and Array access** — a `List`, `Map` or `Array` member is completed
  with its parentheses, because that is how an element is reached: a list inserts
  `items()`, a map or an array inserts `lookup(${1})`, leaving the caret where the
  key or the index goes.
* **Only where a name belongs** — typing `.` offers the type list after `name.` or
  `*name.` and nothing anywhere else (after a member, a call, an index, a number), and
  inside a string or a comment nothing is offered at all, `.` trigger character or not.
* **A sigil opens the list by itself, with what it can actually point at** — typing `@`
  offers procedures (`Declared`, `Proc`, inserted as `Proc()`), a `Declare`, variables of
  any scope (parameter, `Static`, `Global`, pointer) and container elements
  (`@list()`, `@array(0)`, `@map(key)`), and nothing else. Verified against `pbcompiler`:
  a library command (`@Sin(1.0)`), a compile-time pseudo function (`@SizeOf(x)`), a type
  (structure, prototype, module), a constant, an enum member, a macro, a code label and a
  bare container (`@glist`) are all refused, so none of them is offered. `?` offers data
  labels only.
* **Prefix filtering, in any case** — typing a character offers only the names
  that *start* with it, whatever case you type.
* **It waits for you** — nothing pops up until three characters of the name are
  there (`purebasic.completion.minChars`). A list after `.` or `\` is asked for
  by the character itself, so those appear straight away. VS Code's own
  word-based suggestions are turned off for PureBasic, because otherwise they
  would open the popup on the first keystroke regardless.
* **Keywords are re-cased as you type** — a space re-cases the word it finishes
  (`procedure ` → `Procedure `, `foreach ` → `ForEach `, `and ` → `And `), and
  typing `)` re-cases the whole line it closes. Reserved words only: a library
  command can also be a variable name (`left`, `open`, `print`), so those are
  left to the `)`, to Enter, and to Format Text, where the declared names are
  known. Both edits end before the caret, so neither moves it.
* **Enter closes what you opened** — pressing Enter at the end of an opener line
  re-cases that line and puts its terminator on the next one, indented like the
  opener, leaving the cursor on the body line:

  ```text
  procedure test()          Procedure test()
                            |
                            EndProcedure
  ```

  A half-written declaration (`Procedure test`, no parentheses yet) is re-cased
  but not expanded, since it is not the head of a block until its signature
  closes. A line that opens nothing — `If x : y = 2 : EndIf`, an assignment, a
  comment — is left to the editor. This is the `purebasic.newline` command,
  bound to Enter for PureBasic (and hidden from the palette); anything it does
  not handle falls through to the editor's own Enter, so auto-indent,
  multi-cursor and the suggest widget are untouched. It is a command rather
  than on-type formatting because the caret is the point — an edit that lands on
  the caret takes it along, and a formatting provider cannot put it back.

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
macros, constants and labels.

### Across files

PureBasic compiles one translation unit, so another file's procedures only exist
for the compiler when an `IncludeFile` or `XIncludeFile` chain reaches that
file. Completion, hover and signature help follow the same rule with
`purebasic.index.workspace` enabled:

* a file joined to the current one, directly or through any number of further
  includes, contributes its module-level symbols;
* the chain is followed in **both** directions, so in `main.pb` →
  `lib/helpers.pbi` → `lib/deeper/more.pbi` all three files suggest each other's
  symbols;
* a target is resolved the way `pbcompiler` resolves it — relative to the file
  that writes the statement, then through any `IncludePath` directories (each
  relative to the file that declares it);
* the members offered after a `\` are the fields of the structure the variable
  was declared as (`Define p.Point`, `p.Point` or `*p.Point`), including a
  structure from an included file, and each member names its file. A chain is
  followed too, so `m\ImportedList()\` reaches the element structure of a `List`
  or `Map` field and `pt\inner\x` walks a nested structure. Stepping into a member
  that has no members of its own -- an `.i` field, a `$` string, a bare `*pointer`
  -- offers nothing rather than noise; only an owner that cannot be resolved at
  all (an undeclared name, a call, a `With` block) leaves every known field on
  offer;
* symbols from another file carry that file's name after the label
  (`LoadConfig   config.pbi`), and the defining file is the sort key that keeps
  one file's symbols together. The popup has no row of its own for a heading, so
  the file name rides on each item instead;
* files no include reaches are not offered at all, even though they are indexed.

Included files are read even when they live outside the folder (the include walk
reads them from disk), and `PureBasic: Reindex Workspace` redoes the whole scan.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `purebasic.completion.enable` | `true` | Master switch for completion. |
| `purebasic.completion.keywords` | `true` | Offer language keywords. |
| `purebasic.completion.builtins` | `true` | Offer built-in library commands. |
| `purebasic.completion.snippets` | `true` | Insert call snippets with parameter placeholders. |
| `purebasic.completion.minChars` | `3` | Characters to type before the popup appears (`0` = as soon as you type). |
| `purebasic.index.workspace` | `true` | Offer symbols across files, following `IncludeFile`/`XIncludeFile`. |
| `purebasic.index.maxFiles` | `400` | Cap on indexed workspace files and on the include group. |
| `purebasic.format.canonicalCase` | `true` | Restore canonical spelling when formatting and on Enter. |
| `editor.formatOnType` (per language) | `true` | On for PureBasic: the switch for the as-you-type re-casing above. |
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
* Cross-file symbols stop at the include graph: a file that is not reachable
  through `IncludeFile`/`XIncludeFile` contributes nothing, by design.
* Workspace indexing is capped (`purebasic.index.maxFiles`) and re-runs on demand.
* Only the text form of `.pbf` form files is treated as PureBasic.

## Troubleshooting

- `PureBasic: Diagnose Completion at the Cursor` reports the typed word and how many
  items the completion provider returns at the caret. If it says `0 items`, the settings
  in the message tell you which source is disabled; if it lists items while no popup
  appears, the editor is not auto-triggering suggestions there.
