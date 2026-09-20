# PureBasic for Visual Studio Code

PureBasic language support: syntax highlighting, code completion, hover,
signature help, an outline, and formatting. The grammar emits only standard
TextMate scopes, so your theme decides every colour — nothing is pinned.

## Features

* **Syntax highlighting** for the whole language: keywords, all 1888 library
  commands, `#Constants`, `*pointers`, `@addresses`, `?labels`, `var\field`
  members, `Module::item`, `.type` suffixes, both string forms and `!` inline
  assembly.
* **Code completion** for the 1888 library commands with their manual signature
  and parameter list, every language keyword, and your own procedures,
  structures, interfaces, modules, enumerations, macros, constants and
  `List`/`Map`/`Array` containers.
* **Call snippets** — accepting a command inserts its parameters as placeholders
  you can tab through.
* **Hover** showing a command's manual signature, its library, and its
  documentation.
* **Signature help** that follows the parameter you are on as you type.
* **Outline** of the file's declarations.
* **Format Text** restoring the manual's spelling of keywords and commands
  (`endprocedure` → `EndProcedure`) and leaving your own names exactly as
  written.
* **Smart Enter** — pressing Enter on a block opener closes the block and puts
  the caret in its body.
* **Run** — builds the open file, then starts the program in a **window of its
  own**. The compiler talks in the editor's PureBasic terminal, where its
  messages stay as a log, and the program opens in a Terminal window so that its
  output -- `Debug` output above all, which only exists when the debugger is on --
  is somewhere it can be read. The window stays open when the program ends, so
  nothing scrolls away.
* **Compile errors in the editor** — the line the compiler stopped at is
  underlined under your cursor, with what it said about it, and is listed in the
  Problems panel. An error inside an included file is marked in that file.
* **Compile to Executable** — builds the file first, and only then asks where to
  write it, in the save panel of the system you are on, starting at
  `purebasic.compiler.outputPath` or beside the source. A file that does not
  compile is reported in the terminal, with its line underlined in the editor,
  and nothing is asked.
* **Compiler settings** — a button for the options the PureBasic IDE's own
  Compiler Options dialog has: debugger on/off, optimizer, threadsafe, purifier,
  OnError lines, executable format (application, console or shared library),
  subsystem, output path and the program's command line. The debugger has its
  own toggling button, because what it changes is easy to miss: `Debug` output
  and runtime error lines exist only when it is on. It starts on, as the IDE
  ships it.
* **Comments, brackets and indentation** for PureBasic: `;` comments, `()` and
  `[]` pairs, and indentation that follows the language's blocks.
* **Across files** — symbols from files joined to this one by
  `IncludeFile`/`XIncludeFile`, directly or through any number of further
  includes, and only those files.
* **Keywords stay current** — point `purebasic.keywords.path` at a
  `KeywordsData.pbi` from the PureBasic IDE source and a new PureBasic's
  reserved words are picked up without waiting for a release.

## Requirements

PureBasic 6.x, with `pbcompiler` found in the PureBasic installation or on the
PATH. macOS, Linux and Windows are all supported: the compiler switches, the
places the compiler is looked for, and the window the program opens in are each
chosen per platform.
