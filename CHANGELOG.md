# Change Log

All notable changes to the "purebasic" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2026-09-20

First release: PureBasic language support built the same way as the FreeBASIC
extension — plain VS Code providers, in-process, no language server.

### Added

- **Syntax highlighting** from a generated TextMate grammar: keywords by
  category, library commands per library, `#Constants`, `*pointers`, `@proc`
  addresses, `?data` labels, `var\field` members, `Module::item`, `.type`
  suffixes, `~"escape strings"`, `!` inline assembly, and PureBasic's single
  `;` comment form. A keyword inside a string stays a string.
- **Code folding, bracket matching and indentation** from the IDE's
  folding-pair table — all 25 blocks, including `Repeat … Until | Forever`.
- **Code completion**, backed by 1888 library commands (with the manual's
  signatures and libraries) and 111 keywords, plus symbols parsed from the
  current document and the workspace: procedures, structures, interfaces,
  modules, enumerations, macros, constants, lists/maps, fields, arrays, labels
  and parameters.
- **Block scaffolds**: accepting `Procedure`, `Structure`, `Module`, `If`,
  `Select`, `ForEach`, `Repeat`, `CompilerIf`, … at the start of a statement
  inserts the whole block with its terminator.
- **Type awareness**: the built-in type suffixes after a `.` (with what each
  means) and structure/interface names, plus structure members after a `\`.
- **Completion waits for three characters** (`purebasic.completion.minChars`,
  default 3) before the list appears, so a single keystroke no longer opens a
  popup. A type or member list after `.` or `\` still appears immediately, and
  VS Code's word-based suggestions are off for PureBasic so they cannot open the
  popup early themselves. Set the setting to 0 for the previous behaviour.
- **Enter finishes a block**: pressing Enter at the end of an opener line
  re-cases it and puts its terminator on the next line, indented like the opener,
  with the caret left on the body line (`procedure test()` + Enter gives
  `Procedure test()`, an indented body line and `EndProcedure`). A
  half-written declaration is re-cased but not expanded, and a line that opens
  nothing falls through to the editor's own Enter. Bound to Enter through the
  `purebasic.newline` command.
- **Hover** documentation for commands and for the user's own symbols.
- **Signature help** while typing a call, marking optional parameters and
  highlighting the active one.
- **Document outline** for procedures, structures, interfaces, modules,
  enumerations, macros, constants and labels.
- **Workspace symbol index** across `.pb`/`.pbi` files, refreshable with the
  `PureBasic: Rebuild Symbol Index` command.
- **Format Text** (`purebasic.formatText`): restores the canonical spelling of
  keywords and library commands (`endprocedure` -> `EndProcedure`, `redim` ->
  `ReDim`, `messagerequester` -> `MessageRequester`) and leaves the author's own
  identifiers exactly as written, sigils included. Comments and string literals
  are untouched; line endings are preserved; running it twice changes nothing.
- Settings under `purebasic.*` for completion, keywords, built-ins, snippets,
  workspace indexing, canonical-case formatting and tracing.
- `tools/gen-data.mjs` and `tools/gen-grammar.mjs`, which regenerate the
  database and the grammar's word lists from a PureBasic IDE checkout.
- Unit tests for the parser, the completion engine, the casing rewrite and the
  generated data, plus tokenization tests for the grammar and an end-to-end test
  that bundles the extension and drives its providers against a mock editor.
