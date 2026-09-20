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
* **Comments, brackets and indentation** for PureBasic: `;` comments, `()` and
  `[]` pairs, and indentation that follows the language's blocks.
* **Across files** — symbols from files joined to this one by
  `IncludeFile`/`XIncludeFile`, directly or through any number of further
  includes, and only those files.
* **Keywords stay current** — point `purebasic.keywords.path` at a
  `KeywordsData.pbi` from the PureBasic IDE source and a new PureBasic's
  reserved words are picked up without waiting for a release.

## Requirements

PureBasic 6.x. The extension neither ships nor invokes the compiler; it is a
language service only.
