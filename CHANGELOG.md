# Change Log

All notable changes to the "purebasic" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.8] - 2026-09-21

### Added

- **A Debug Output panel in the secondary side bar**, where the program's own output goes: `Debug`
  statements, anything else the program prints, and -- for a run under the debugger -- what the
  debugger has to say about it. It has Clear and Stop, and keeps the end of a long run.
- `PureBasic: Run in a Terminal`, for a program that reads from the keyboard.

### Changed

- **Run no longer opens a Terminal window of its own.** The program is started by the extension with
  its output going to that panel, which is what makes the panel possible; its own window, for a
  windowed program, is unaffected. The compiler's messages still go to the editor's terminal.
- The extension now asks for VS Code 1.90 or later, for the secondary side bar.

## [0.2.7] - 2026-09-21

### Changed

- **Run uses the debugger when there is something to stop at**, which is both of these at once: the
  debugger switched on -- the bug button in green -- and at least one breakpoint in the gutter.
  Otherwise it does what it always did, a plain run in a window of its own without the debugger's
  overhead. The Debug button is still there to start a session on its own say-so, and it is only
  offered while the debugger is on.
- **No more dropdown on the play button.** Run, Debug and Compile are plain title-bar buttons, so no
  menu of debug configurations hangs off the play button any more.
- Starting a session with the debugger switched off is refused with a word about why, rather than
  begun and left with nothing to talk to.

## [0.2.6] - 2026-09-21

### Added

- **A Debug button in the editor's title bar**, beside Run, and F5 does the same. Run is a plain run
  -- build, then start the program in a window of its own -- and does not stop at breakpoints; Debug
  is the one that starts a session. The README says so now, which it should have from the start.

### Fixed

- The adapter's messages carry the sequence numbers the protocol requires, and the extension is woken
  for `onDebug` and `onDebugResolve:purebasic` rather than only by the language.

## [0.2.5] - 2026-09-21

### Added

- **A debugger.** F5, or `PureBasic: Debug`, builds the file with the debugger in it and starts it
  under PureBasic's own debugger engine -- the one the standalone debugger drives -- through a DAP
  front-end in this extension: breakpoints in the gutter, Continue, Step In, Step Over and Step Out,
  a call stack from the procedure history, and a variables view in the Debug console covering values,
  structures with their members, and arrays, lists and maps fetched as they are opened. The program's
  `Debug` output lands there too, and a runtime error stops the program on the line that caused it.
  Step Over and Step Out are worked out from temporary breakpoints, the command-line debugger itself
  stepping only a line at a time.
- Launch configurations for the `purebasic` debugger type, so a `.vscode/launch.json` can name the
  source, its working directory and its command line, with the compiler settings, the platform and
  the build's destination filled in from the extension's own.

### Changed

- The extension carries `node-pty`, whose prebuilt binaries give the debugged program the terminal
  its debugger insists on. Those are there for macOS and Windows; debugging on Linux waits for a
  build of that library for the platform. Nothing else is affected by it.

## [0.2.4] - 2026-09-21

### Added

- **The line the compiler stopped at is underlined**, in the editor and in the Problems panel, with what
  the compiler had to say about it. An error inside an included file is marked in that file and on its
  own line. Typing over the line takes the mark away, so an error that has been fixed does not keep its
  squiggle until the next build.

### Changed

- **Run builds before it starts anything**, as Compile does, and from the extension rather than in the
  terminal -- the errors have to be read here to be underlined, and a file that does not compile must
  not start. The terminal still shows the build's log and then the command that starts the program, so
  the compiler's messages are there as they were.

## [0.2.3] - 2026-09-21

### Changed

- **Compile to Executable builds before it asks where to write**, so a file that does not compile is
  reported in the terminal rather than asked about, and the save panel is never opened for a build that
  failed. The build is staged out of the way, then moved to the chosen path -- across volumes as well,
  with the executable bit kept -- and what the compiler said is put in the terminal all the same. The
  status bar shows the build while it runs, since it no longer runs in the terminal.

## [0.2.2] - 2026-09-21

### Added

- **Compile to Executable asks where to write**, in the platform's own save panel -- the save dialog on
  macOS, the common dialog on Windows, the desktop's own on Linux -- so the places that machine offers
  are in it. It opens at `purebasic.compiler.outputPath`, or beside the source under the source's name,
  and a cancelled panel compiles nothing rather than something in the wrong place.

### Changed

- `purebasic.compiler.outputPath` is now where that panel opens: a file to write there, or a folder to
  write the usual name in. It used to be handed to the compiler as-is, which a folder could not survive.

## [0.2.1] - 2026-09-20

### Added

- **Linux and Windows**, alongside macOS. The compiler switches are per platform (`-d -cl -o` on
  Unix, `/DEBUGGER /CONSOLE /EXE` on Windows), the compiler is looked for where each platform keeps
  it and then on the PATH, and a Run opens the program in a window of its own: a Terminal window on
  macOS, a terminal emulator on Linux, a console window on Windows. Where no window can be had, the
  program runs in the build terminal rather than not at all.
- `purebasic.compiler.executableFormat` is now `windowed`, `console` and `library` rather than
  `macos`, `console` and `dylib`, which only made sense on one platform. The old names are still
  read, and a library is written `.dylib`, `.so` or `.dll` as the platform wants.

### Changed

- A Run is one command in the editor's terminal: the build, then `&&`, then starting the program.
  A build that failed starts nothing, and the compiler's messages stay in that terminal -- which
  also removes the exit-code file the two-terminal arrangement needed, and with it the last piece
  of shell syntax the extension depended on.

## [0.2.0] - 2026-09-20

### Added

- **Run** builds the file and opens the program in a Terminal window of its own, so `Debug` output
  has somewhere to be read. The compiler keeps talking in the editor's PureBasic terminal, where
  its messages stay as a log, and a failed build starts nothing.
- **Compile to Executable** writes a binary beside the source, or wherever
  `purebasic.compiler.outputPath` says.
- **Compiler settings**, from a settings button and as editor title buttons: debugger, optimizer,
  threadsafe, purifier, OnError lines, executable format, subsystem, output path and the program's
  command line -- the options the IDE's own Compiler Options dialog has. The debugger defaults to
  on, as the IDE ships it, and its button turns green while it is on.

### Changed

- Compiler settings set from the buttons are written globally rather than into whichever folder is
  open.

## [0.1.25] - 2026-09-20

### Changed

- **A declared name is normal text, as the PureBasic IDE draws it.** `MemDll` in `Module MemDll` and in
  `DeclareModule MemDll` was `entity.name.type.purebasic`, which is the green the dark themes
  VS Code ships use for a Structure. The IDE has no declaration colour at all: its highlighter
  ([`HighlightingEngine.pb`](https://github.com/fantaisie-software/purebasic/blob/master/PureBasicIDE/HighlightingEngine.pb))
  assigns a colour by what *surrounds* a word, never by the word being declared.
  - `Module` / `DeclareModule` / `Structure` / `Interface` / `Enumeration` / `Macro` are Basic
    Keywords, so they stay the keyword colour.
  - the name after any of them has nothing following it, so it is Normal Text -- `MemDll` is white.
  - `entity.name.type.purebasic` is gone from the grammar; no scope was invented in its place, so a
    theme paints a declared name with its own normal text, the same choice the built-in type
    suffixes already get. The one exception is `Macro M`'s name, which was
    `entity.name.function.purebasic` and is now plain too.
  - the rules that DO colour a name are the positional ones, and they are unchanged: a `(` after it
    (`Procedure.d Area(...)`, `Declare.i Bar(...)`, `Prototype.i Callback(...)`) is the function
    colour, a `::` is the module colour (`MemDll::DoIt()`), a `.Structure` or a `\` is the
    structures colour (`pt.Point`, `test\age`).
- The opt-in IDE palette dropped the rule for the removed scope: the base normal-text rule
  already covers a declared name, so the opt-in palette is unchanged in what it renders.

### Note

- The IDE gives the `::` of `MemDll::DoIt()` its operator colour, while this grammar includes it in
  the member token, so it comes out green rather than pink. Left alone for now; it is a one-token
  difference and nothing else depends on it.

## [0.1.24] - 2026-09-20

### Added

- **`purebasic.keywords.path`**: point it at a `KeywordsData.pbi` from the PureBasic IDE source and any
  reserved word it has that this extension does not is picked up at startup, so a new PureBasic's
  keywords do not have to wait for a release here. `PureBasic: Refresh Keywords` re-reads it on
  demand. Nothing else about the highlighting or the completion changes.
  - The two halves land at different times, because they have to: completion, hover and canonical
    case read an in-memory overlay and are effective at once, while highlighting reads the TextMate
    grammar the editor loads. There is no way to register a grammar at runtime, so the new words are
    appended to that file and take effect on the next window load; the extension says how many it
    found and offers to reload.
  - The grammar merge is strictly additive -- it appends to one keyword alternation and leaves every
    other rule byte for byte as it was -- and the refresh only ever adds, so running it twice writes
    nothing. A read-only install costs the colours and not the completion.
  - The file belongs to the IDE *source*: a PureBasic installation ships catalogs, colorschemes,
    compilers, purelibraries, residents, sdk, subsystems and themes, and no keyword table. This reads
    the `BasicKeywords` section and honours its `CompilerIf #SpiderBasic` guards the way a PureBasic
    build does, so SpiderBasic's DisableJS/EnableJS stay out.

### Fixed

- The integration harness's `Uri.joinPath` was implemented with `dirname`, so joining onto a
  directory produced a path one level too high. It is segment-based in the real API, and is now
  faithful; the bug was hiding the grammar write from the new test.

## [0.1.23] - 2026-09-20

### Fixed

- **0.1.22's nine keywords reached the syntax highlighter but not the completion list.**
  `tools/gen-data.mjs` writes two files from one run -- `src/data/pb-builtins.json`, which the
  grammar is generated from, and `src/data/pb-builtins.ts`, which the extension imports for
  completion, hover and canonical case. Only the `.json` was updated, so `List`, `Map`, `Array`,
  `As`, `CallDebugger`, `DebugLevel`, `DisableDebugger`, `EnableDebugger` and `IncludePath` were
  coloured and not offered. 0.1.20's guard could not see it: the grammar was correct.
- The `.ts` is now a pure function of the `.json`, written by `tools/gen-builtins-ts.mjs` and used
  by `gen-data` too, so there is one emitter and no second writer to fall behind:
  - `npm run build` regenerates it from the JSON before bundling, and `vsce package` runs `build`;
  - `node tools/gen-builtins-ts.mjs --check` fails when the two disagree, and `npm run check` runs
    it next to the grammar check;
  - two tests pin them together from the side that matters -- every item and every keyword in the
    `.json` must be present in the data the extension actually offers. Restoring the stale `.ts`
    makes them fail with `src/data/pb-builtins.ts is stale -- run npm run gen-builtins-ts`.

### Verified

- Each of the nine is now offered by completion, checked by running the provider:
  `Lis` -> `List`, `Arr` -> `Array`, `Call` -> `CallDebugger`, `Incl` -> `IncludePath`,
  `Deb` -> `DebugLevel`, and the two debugger directives by their full names.

## [0.1.22] - 2026-09-20

### Fixed

- **Nine reserved words the IDE highlights were missing**, so they were neither coloured as
  keywords nor offered in completion:
  `List`, `Map`, `Array`, `As`, `CallDebugger`, `DebugLevel`, `DisableDebugger`,
  `EnableDebugger`, `IncludePath`.
  `List` in `List Items.Inner()` was the visible one: plain text instead of the keyword colour,
  including inside a structure block.
- The keyword data now comes from the IDE's own table,
  [`PureBasicIDE/KeywordsData.pbi`](https://github.com/fantaisie-software/purebasic/blob/master/PureBasicIDE/KeywordsData.pbi),
  as well as the script table it came from before. `tools/gen-data.mjs` merges whatever that file
  knows and the other does not, so a regeneration keeps them. It honours the file's
  `CompilerIf #SpiderBasic` guards and treats `#SpiderBasic` as false, which is what keeps
  SpiderBasic's `DisableJS`/`EnableJS` out of a PureBasic extension -- verified: the file yields
  111 names for us out of its 113, and exactly the nine above were new.

### Note

- The two tables disagree on the spelling of two words the IDE auto-corrects to `ForEver` and
  `XOr`, while this extension has `Forever` and `Xor`. The grammar matches either way, so no
  colour changes; only what `PureBasic: Format Text` writes would. Left as it is.

## [0.1.21] - 2026-09-20

### Changed

- **A built-in type is plain normal text, the way the PureBasic IDE draws it.** This releases the
  type suffix from `storage.type.purebasic`, which was an invention: the IDE has no "type" colour
  at all. Its highlighter,
  [`PureBasicIDE/HighlightingEngine.pb`](https://github.com/fantaisie-software/purebasic/blob/master/PureBasicIDE/HighlightingEngine.pb),
  upper-cases the word after a `.` and asks whether it is ONE character of
  `#BasicTypeChars = "ABCUWLSFDQI"`:
  ```purebasic
  If OldSeparatorChar = '.'
    WordStart$ = UCase(WordStart$)
    If Len(WordStart$) = 1 And FindString(#BasicTypeChars, WordStart$, 1) ; check for the basic types
      Callback(*StringStart, *Cursor-*StringStart, *NormalTextColor, 0, TextChanged)
    Else
      Callback(*StringStart, *Cursor-*StringStart, *StructureColor, 0, TextChanged)
    EndIf
  ```
  So `i l s a b c w u f d q` -- and their capitals, and the `.p-ascii` / `.p-utf8` / `.p-bstr` /
  `.p-variant` / `.p-unicode` string forms -- are normal text, and **anything longer is a structure
  name** and keeps the Structures colour. `test.i` is now plain end to end; `test.my_test` is still
  green end to end. The same rule covers a return type, so `Procedure.d`, `Declare.i` and
  `Prototype.i` no longer colour the type: the IDE paints those NormalText too.
- **The name in front of a built-in type is plain as well**, because the IDE treats it that way
  (`p` and `Point` in `Define p.Point` are green, but `n` and `d` in `n.d = 1` are both normal
  text). This is narrower than "a dot turns the name green": the dot only does that when what
  follows it is a structure.
- No scope was invented to replace `storage.type.purebasic`. Those tokens carry no scope, so each
  theme paints them with its own normal text -- there is no colour override anywhere in the
  package, neither in the grammar nor in the extension's settings.

### Verified

- Every built-in type, in both cases, through a declaration, a parameter, a return type and a
  structure field, is confirmed unscoped under the tokenizer the editor uses.
- The opt-in IDE palette dropped the now-meaningless `storage.type.purebasic` rule; its
  26 selectors all name a scope the grammar emits, and all 27 scopes it covers render the exact
  colour the IDE's own scheme uses.

## [0.1.20] - 2026-09-20

### Fixed

- **The highlighting in 0.1.19 never reached you, and now it does.** The grammar file the editor
  loads is generated, and a stray apostrophe in a comment made `tools/gen-grammar.mjs` fail to
  parse. The failure was swallowed, the committed grammar stayed at the previous revision, and
  0.1.19 was packaged from it -- so none of that release's scope changes were visible and
  `*pointer` was still white. The generator parses again and the grammar is regenerated.
- A stale grammar can no longer ship quietly:
  - `npm run build` regenerates the grammar before it bundles, and `vsce package` runs `build`,
    so the packaged file is always the one the generator produces;
  - `node tools/gen-grammar.mjs --check` compares the committed file with the generator and exits
    non-zero when they differ; the test suite runs it, so a stale or unregenerable grammar fails
    CI rather than reaching a user. The suite could not catch this before, because it tokenizes
    whatever file is on disk -- stale or not.

### Changed

- **A library command and a call of your own procedure are one scope**,
  `entity.name.function.purebasic`. The IDE gives `MessageRequester` and `MyProc(1)` the same
  Functions colour, so a separate `support.function.purebasic` bought a distinction no scheme
  could show. Every library command is still matched from the IDE's own table.
- **A member and the name it comes off are one scope**, `entity.name.type.member.purebasic`
  (was `variable.other.member` / `variable.other.typed`). The IDE paints a member with its
  Structures colour, and `variable.other.*` gets whatever a theme gives a variable -- white in
  those themes. `OBJ_MEMDLL\ModulesMap()` is now one green expression instead of a green owner beside
  a grey member, which is what the IDE shows.
- Compiler directives, includes and macros are `keyword.other.preprocessor.purebasic` (was
  `meta.preprocessor.purebasic`, which several themes leave uncoloured).

### Verified

- Every scope the grammar can emit was tokenized and resolved against the themes VS Code ships,
  so each one's rendered colour is known rather than assumed. Under the dark theme in use: keywords,
  directives and operators `#F92672`; commands and procedure names `#A6E22E`; structures, type
  uses, members and module qualifiers `#A6E22E`; constants, numbers, pointers and `@addresses`
  `#AE81FF`; strings `#E6DB74`; comments `#88846F`; the native `.i` suffix `#66D9EF`.
- The opt-in IDE palette was rewritten for these scopes and
  machine-checked: all 27 selectors name a scope the grammar really emits, and all 28 scopes
  render the exact colour the PureBasic IDE's own scheme uses. (That theme has no
  rule for a label or for an inline-assembly line, so under that theme a label is white and
  `! mov eax, 1` is plain text; the palette is how you get the IDE's orange and cyan back.)

## [0.1.19] - 2026-09-20

### Changed

- **A pointer and an address are scoped in the constant family**, `constant.other.pointer.purebasic`
  and `constant.other.reference.purebasic`, rather than under `variable.other`. The scope decides
  which colour a scheme gives them, and in the PureBasic IDE's own scheme `PointerColor`
  *is* `ConstantColor` -- while in the dark themes VS Code ships the purple family is `constant.*`.
  Under the theme then in use a pointer was coming out `#F8F8F2` (its variable colour); it is now
  `#AE81FF`, the same purple as `#MAX` and a number, which is what the IDE shows. Verified against
  the theme: `*pointer`, `*buffer`, `@test`, `#max`, `$FF`, `%1010`, `12.5` all render `#AE81FF`.
- Two things stay the theme's word, because that theme has no scope of its own for them: a member
  read (`test\age`) and a data label reference (`?data`) come out the theme's normal text. The
  opt-in IDE palette still pins them if you want the IDE's own
  colours over whatever theme you run.

## [0.1.18] - 2026-09-20

### Changed

- **The colouring vocabulary now follows [duty1g/vscode-purebasic](https://github.com/duty1g/vscode-purebasic)**
  (MIT). Its scopes are the standard ones a theme already knows, so the colours come from the theme
  rather than from anything the extension pins:
  - the twelve keyword groups collapse to its four: `keyword.control.purebasic`,
    `keyword.other.purebasic`, `meta.preprocessor.purebasic` (compiler directives, includes,
    macros) and `keyword.operator.purebasic` (word and symbol operators);
  - library commands are one scope, `support.function.purebasic` -- the per-library name is gone,
    which also retires the `stringlib` workaround, since a scope with `string` in it reads as a
    string token and silences completion;
  - numbers become `constant.numeric.decimal|hex|bin|float.purebasic`, constants
    `constant.other.predefined.purebasic` and `constant.language.boolean|null.purebasic`, labels
    `entity.name.label.purebasic` with the colon, and `:` is
    `punctuation.separator.statement.purebasic`;
  - a name on its own is left unscoped, so the theme paints it normal text, which is what the
    PureBasic IDE does too.

### Kept from ours, because that grammar has no rule for them

Pointers (`*p`), addresses (`@proc`), data label references (`?label`), member access
(`obj\map()`, `Module::item`), the structure block with its type declaration and reference scopes,
the name taking a type, and the `!` assembly line. Its type rule is `\b([ilqbfwdsa])\b`, which
matches any single letter anywhere -- `i = 0` would be a type -- so our suffix stays anchored after
a dot, and its hex literal rule uses `\b` before `$`, which can never match, so ours keeps the
lookbehind that works.

## [0.1.17] - 2026-09-20

### Changed

- **A member access is one piece of code.** `OBJ_MEMDLL\ModulesMap()` -- the owner, the `\`, the
  member and the empty element access -- is a single `variable.other.member.purebasic` token now,
  and a name followed by `\` takes `variable.other.typed.purebasic` like one taking a type, so a
  scheme can paint the whole expression as what it is: something that comes off a structure. A
  variable on its own is still normal text, so `count = count + 1` stays plain while `test\age`
  does not.

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
  IDE's own preferences (`~/.purebasic/purebasic.prefs`, its shipped scheme) and measured from a
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
  `%`, `<`, `>`, `&`, `|` and the two-character forms. The PureBasic IDE's own scheme gives them
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
