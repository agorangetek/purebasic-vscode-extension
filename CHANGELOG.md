# Change Log

All notable changes to the "purebasic" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.16] - 2026-09-20

### Changed

- **A variable is normal text until it takes a type.** A name with a `.` after it --
  `test.my_test`, `name.s`, `localVar.i` -- is the one that wears the code colour, and it has its
  own scope now, `variable.other.typed.purebasic`; every other name keeps
  `variable.other.purebasic`, and a member read keeps `variable.other.member.purebasic`, both of
  which are normal text. The grammar's catch-all was a single rule and is now two, the typed one
  first, so a scheme can tell `count = count + 1` from `count.d = 1`.

## [0.1.15] - 2026-09-20

### Changed

- **Declaration and use are scoped apart, the way the PureBasic IDE colours them.** Read off the
  IDE's own preferences (`~/.purebasic/purebasic.prefs`, the Monokai scheme) and measured from a
  screenshot rather than guessed: a *declaration* is normal text -- a structure's name, a field
  line in a `Structure`, a native suffix such as `.i` -- while a *use* in code wears the colour the
  IDE gives identifiers and commands. So:
  - the `field` rule is gone: a field line is left as normal text (`Structure Point` and the
    `name.s` under it stay plain, as in the IDE), and a `*` field is coloured by the pointer rule
    like any other pointer;
  - a plain identifier is now `variable.other.purebasic`, from a catch-all rule that sits last in
    the grammar so it only claims what nothing else did;
  - a type after a dot is `entity.name.type.reference.purebasic` instead of sharing the
    declaration's `entity.name.type.purebasic`.
  A scheme can now tell `Structure my_test` from `test.my_test`, which is exactly what the IDE
  does: plain text for the first, its command colour for the second.

## [0.1.14] - 2026-09-20

### Added

- **Symbolic operators are scoped**, as `keyword.operator.symbol.purebasic`: `=`, `+`, `-`, `*`, `/`,
  `%`, `<`, `>`, `&`, `|` and the two-character forms. The PureBasic IDE's Monokai scheme gives them
  the keyword colour (its OperatorColor), and no selector could reach them while they were
  unscoped. The rule sits after the sigil rules, so the `*` of `*p` is still a pointer and only a
  lone `*` -- a multiplication -- is an operator.

### Changed

- A `*`-prefixed field declaration (`*Entry` inside a `Structure`) is a pointer, not a member: the
  IDE gives it the pointer colour and it has to match `*buffer`. A plain field is still scoped like
  its `\field` reader.

## [0.1.13] - 2026-09-20

### Changed

- **A structure member is scoped the same where it is declared and where it is read.** A field line
  in a `Structure`, `Interface` or `StructureUnion` was unscoped, so `Function.i` came out
  uncoloured while `test\Function` was `variable.other.member.purebasic`; both sides now share
  that scope, which is how the PureBasic IDE colours them (as one). This needed the structure body
  to become a real block in the grammar, so a nested `StructureUnion` keeps its own block and its
  keyword colour, and a bare `x.i` inside a procedure or at module level stays an ordinary
  variable, not a member.
- **A type name after a dot is scoped like the name where it is declared.** `test.IMAGE_THUNK_DATA`
  is `entity.name.type.purebasic`, the same as `Structure IMAGE_THUNK_DATA`, instead of
  `storage.type.purebasic` -- under a default theme the two used to differ (blue against teal).
  Only the native single-letter suffixes stay `storage.type.purebasic`, which is the IDE's own
  `type` colour; pbcompiler reserves those letters as structure names, so there is no ambiguity.
- **A `*` is a pointer only when it is glued to the name and not glued to what precedes it.** `a*b`,
  `a * b` and `2*3` are multiplications, which the PB IDE's own highlighter test asserts; `*p`
  after `=`, `(` or the start of a line keeps `variable.other.pointer.purebasic`.

## [0.1.12] - 2026-09-20

### Changed

- **What a sigil offers is now what `pbcompiler` actually accepts**, checked form by form against
  6.41. After `@` (and `*`) it offers a procedure, a `Declare`, a variable of any scope -- a
  parameter, a `Static`, a `Global`, a pointer -- and a container *element* (`@list()`,
  `@array(0)`, `@map(key)`), and nothing else. Refused by the compiler, so no longer offered: a
  library command (`@Sin(1.0)` is "not declared"), a compile-time pseudo function
  (`@SizeOf(x)`), a type (structure, prototype or module), a constant, an enum member, a macro,
  a code label, and a bare container (`@glist`).
- A procedure is inserted as `Name()` after a sigil, because `@Proc()` is the address while
  `@Proc(1)` is a syntax error.
- `?` offers data labels only.
- A `Prototype` declaration now has its own symbol kind. It is a type, unlike a `Declare`, and
  only that difference lets a completion tell the two apart.

## [0.1.11] - 2026-09-20

### Fixed

- **Typing `@` offered nothing.** The pacing that waits for three characters stripped the
  sigil before measuring, so `@` counted as nothing typed, and the pattern the extension read
  the line with could not report a bare sigil at all. A sigil is a deliberate request, like `.`
  and `\`: `@` alone now lists what it can point at -- your own procedures and variables first,
  then the library procedures -- and `@` is registered as a trigger character so the editor asks
  for it directly. Keywords are left out of that list, since none of them can be addressed, and
  the block openers no longer appear either: a sigil has already started the expression.

## [0.1.10] - 2026-09-20

### Fixed

- **A `@` with no name after it was left unscoped.** `@ThreadProcedure1` carried
  `variable.other.reference.purebasic`, but a bare `@` (while typing one, or before something
  that is not a name) matched no rule at all, so it fell back to the editor's default colour and
  a reference could look half-coloured. Every `@` now takes the reference scope, and the sigil is
  part of the token, so one selector colours the whole thing. `@` has no other meaning in
  PureBasic, which is why this is safe; a bare `*` is the multiplication operator and cannot be
  told apart from a pointer sigil, so it is deliberately left alone.

## [0.1.9] - 2026-09-20

### Changed

- **A `.` only offers the type list where a type name belongs.** Any dot used to mean "a type
  goes here", so `test\ImportedList().` and `test\ImportedList()\ImportedDllHandle.` offered the
  type list, and `IncludeFile "memdll.` offered every name in the language -- `.` is a trigger
  character, so the editor asked even inside a string. The context is now checked against what
  precedes the dot: a type list only after `name.` or `*name.`, and nothing at all after a
  member access, a call, an index, a number, a second suffix, or anywhere inside a string or a
  comment. `~"..."` is understood, so `\"` does not end a string, while a plain string takes no
  escapes.
- A `\` after a number or an operator is refused the same way; a bare `\` (a `With` block) and
  `list(0)\` are still member contexts.

## [0.1.8] - 2026-09-20

### Changed

- **Stepping into a member that has no members offers nothing.** `m\ImportedList()\ImportedDllHandle\`
  used to list every field of every known structure, because a chain that could not be resolved
  to a structure fell back to the generous list. A native leaf -- an `.i` field, a `$` string, a
  bare `*pointer`, or a variable declared without a type -- is now recognised as such and offers
  nothing at all. Only an owner that cannot be resolved *at all* (an undeclared name, a call
  result, a `With` block) still leaves every known field on offer.

## [0.1.7] - 2026-09-20

### Fixed

- **A `List`, `Map` or `Array` member was completed as a bare name.** `m\ImportedList` came out
  without the parentheses an element access needs, so the suggestion was reported missing its
  `()`. A list now inserts `items()`, since the empty form reads the current element, and a map
  or an array inserts `lookup(${1})`, leaving the caret where the key or the index goes. The
  parser keeps the `List`/`Map`/`Array` keyword of a field, which it used to throw away.

### Changed

- Enter no longer runs the newline command while a snippet placeholder is active
  (`!inSnippetMode`), so pressing Enter inside `MessageRequester(${1:title})`, or inside a map
  key, cannot fire the block-expanding newline instead.

## [0.1.6] - 2026-09-20

### Changed

- Members follow a chain of structures, not just one step: `m\ImportedList()\` now offers the
  members of the structure a `List` or `Map` field holds, and `pt\inner\x` walks a nested
  structure. A quoted key (`Lookup("k")`) is handled too, even though the masked text has
  already blanked the string. An untyped pointer (`*EntryPoint`) still leaves every known
  field on offer, because nothing better can be told. Checked against `MemDll.pb`, where the
  `List ImportedList.MEMDLL_IMPORTED_LIBRARY()` field of `MEMDLL_MODULE` needs exactly this.

## [0.1.5] - 2026-09-20

### Fixed

- **A structure field whose name began with a directive keyword was dropped.** The guard that
  keeps `Import`/`Compiler…`/`Data` lines out of a structure block matched on a bare prefix, so
  `ImportedDllName$` was read as an `Import` and never became a field -- and neither did a
  `List Items.Inner()` or `Map Lookup.Inner()` field, which the same guard rejected as a bare
  `List`/`Map`. Directives are now matched as whole keywords, which is the difference between
  `Imported…` and `Import`. Found with a real 1154-line library (`MemDll.pb`).
- **A variable declared as `x.MyStruct`, with no `Define`, was not recognised.** `pbcompiler`
  accepts the bare form (its own `x.MyStruct = 3` is rejected as "Can't assign a value to a
  structure"), so it now declares a variable of that type like the `Define` form does; `x.i` and
  `*p.MyStruct` too.

### Changed

- Members offered after a `\` are the fields of the structure the variable is declared as,
  instead of every field of every known structure; a file with many structures no longer mixes
  them. A member that comes from an included file names that file, as does a structure offered
  after a `.`. When the type cannot be told from the declaration, every field is still offered
  rather than showing an empty list.

## [0.1.4] - 2026-09-20

### Fixed

- **A structure declared in an included file offered none of its members.** The index handed out
  module-level symbols only, so a field -- which belongs to its structure, not to the file --
  never crossed a file boundary: `Point` from an included file was completed, but `p\` after
  `Define p.Point` listed nothing. Fields now travel with the include group, and a field is still
  never offered as an ordinary name, only where a member is expected. Found by running the
  extension in a real editor host against two files, one including the other.

## [0.1.3] - 2026-09-20

### Changed

- **Cross-file completion now follows `IncludeFile`/`XIncludeFile` instead of the whole
  folder.** PureBasic compiles one translation unit, so a procedure in another file only
  exists for the compiler when an include chain reaches it; offering every `.pb`/`.pbi`
  file in the folder suggested names that would not compile. A file now contributes only
  when it shares the current file's translation unit, and the chain is followed in both
  directions and transitively: in `main.pb` -> `lib/helpers.pbi` -> `lib/deeper/more.pbi`,
  all three files suggest each other's symbols. Targets resolve the way `pbcompiler`
  resolves them -- relative to the file that writes the statement, then through
  `IncludePath` directories, each relative to the file that declares it -- including
  targets outside the workspace folder, which are read from disk.
- An item offered from another file now shows that file after its label
  (`LoadConfig   config.pbi`) and sorts with the rest of its file. VS Code has no row for
  a group heading in the popup, so the file name rides on each item.

### Added

- `IncludePath` directives are parsed and used to resolve includes, and
  `test/includes.test.ts` covers the resolution rules and the shape of the graph.

## [0.1.2] - 2026-09-20

### Fixed

- **Typing `str` -- or any other String library command -- never brought up the completion
  list.** Those commands were scoped `support.function.string.purebasic`, and VS Code picks
  the `editor.quickSuggestions` entry that applies to a keystroke from the *innermost scope*
  of the token at the caret, matching `/\b(comment|string|regex|regexp)\b/`. The bare word
  `string` made the editor treat a code token as a string literal, and string suggestions
  default to off, so it never asked the extension. The library scope is now
  `support.function.stringlib.purebasic`: `str`, `strd`, `left`, `mid`, `len`, ... pop up
  like every other command. A theme that targeted the old scope needs the new name; a
  regression test now tokenizes all 1999 built-in names and fails if any is classified as a
  string or a comment.

## [0.1.1] - 2026-09-20

### Fixed

- The completion prefix is now read from the line text instead of the editor's word
  range, so a prefix like `str` is measured — and filtered — exactly as the service
  computes it.

### Added

- `PureBasic: Diagnose Completion at the Cursor` reports the typed word and the number
  of items the provider returns, telling a settings problem apart from an editor
  trigger problem.

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
- **Keywords are re-cased as you type**: a space restores the manual's spelling
  of the word it finishes (`procedure ` -> `Procedure `, `foreach ` ->
  `ForEach `), and `)` re-cases the whole line it closes. Reserved words only --
  a library command can also be a variable name, so those wait for `)`, Enter or
  Format Text, where the declared names are known.
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
