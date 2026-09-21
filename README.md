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
* **Debug Output panel** — opens by itself when a PureBasic file is opened or
  made, and shows what the program prints: `Debug` statements, anything else it
  writes, and what the debugger has to say during a run under it. It has Clear
  and Stop, and does not take the caret away from the editor when it opens.
* **Run** — builds the open file, then starts it, with everything it prints --
  `Debug` output above all -- going to the **Debug Output** panel in the
  secondary side bar, the right-hand one, where it can be read beside the code
  and stays put. With the debugger switched on (the bug button, green) and at
  least one breakpoint in the gutter to stop at, it runs under the debugger
  instead, so it stops at those breakpoints. With either of those missing it is
  a plain run, which is faster. A program that reads from the keyboard wants
  `PureBasic: Run in a Terminal`, which runs it in a terminal instead. The compiler talks in the editor's PureBasic terminal, where its
  messages stay as a log, and the program opens in a Terminal window so that its
  output -- `Debug` output above all, which only exists when the debugger is on --
  is somewhere it can be read. The window stays open when the program ends, so
  nothing scrolls away.
* **Debug** — F5 (or `PureBasic: Debug`) builds the file with the debugger in it and runs it under
  PureBasic's own debugger: breakpoints in the gutter, Continue, Step In, Step Over and Step Out, a
  call stack from the procedure history, and variables -- values, structures with their members, and
  arrays, lists and maps loaded as they are opened -- in the Debug console, where the program's
  `Debug` output goes as well -- and to the Debug Output panel, with the rest of
  what the program prints. A runtime error stops the program on the line that caused it.
  The adapter is this extension's; the debugger doing the work is the one a `-d` build carries, which
  is the same engine the standalone debugger drives.
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

Debugging needs a terminal for the program being debugged, which the packaged `node-pty` provides:
its prebuilt binaries are there for macOS and Windows. On Linux, debugging waits for a build of that
library for the platform; compiling and running are unaffected.
