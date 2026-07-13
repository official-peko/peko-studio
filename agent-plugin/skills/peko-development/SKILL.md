---
name: peko-development
description: Use when working in a PekoScript project (any repo with a peko.toml or .peko files) - building, running, type-checking, formatting, managing dependencies with the peko CLI, and writing PekoScript or pekoui code.
---

# Peko development

PekoScript is a statically typed, LLVM-compiled, garbage-collected language that
builds cross-platform native binaries. Source files use the `.peko` extension and
are real source files, not text. A project is defined by a `peko.toml` at its root.
The `peko` CLI drives everything: compiling, running, testing, formatting, and
dependency management.

## Orient first

Before changing anything, understand the project:

- Read `peko.toml`. `[project].entry` is the main source file. `[ui].framework`
  tells you if it is a UI app (pekoui) or a plain CLI/binary project. `[dependencies]`
  lists packages.
- Source lives under `src/` by convention, entry point named in `peko.toml`.
- `peko project show-info` prints the resolved configuration.

## The core loop

Prefer the fastest check that covers your change, then escalate.

- `peko test <file.peko>` - type-check ONE file and print diagnostics. Fast. No
  codegen. Use this constantly while editing to catch errors early. Add
  `--os=<os> --arch=<arch>` to check a specific target's platform imports.
- `peko build` - full build. For a plain project this produces one host binary;
  for a UI project it bundles every platform in `[project].target_platforms`. Use
  `--platform=<os>` to build just one, `--release` for optimized + signed output.
- `peko run` - build and run. For a UI project this is a hot-reload dev loop
  (source and style changes are pushed to the running app). For a CLI project it
  compiles then executes once.
- `peko format <files...>` - normalize indentation and spacing. Run this on any
  `.peko` file you edited before finishing.

Typical flow for a code change: edit, `peko test` the changed file(s), then
`peko build` to confirm the whole project links. Fix diagnostics before moving on.

## Dependencies

- `peko add <package>` adds a registry dependency to `peko.toml` and installs it.
  `--version=^1.2` pins a requirement; `--path=<dir>` adds a local path dependency.
- `peko remove <package>` removes one. `peko install` resolves and locks;
  `peko update` re-resolves and refreshes `peko.lock`. Do not hand-edit `peko.lock`.

## Language conventions

- Types: `Type?` is an optional (do not expand it to `Option<Type>` by hand).
  Managed pointers are `pointer<T>`. Classes and constants are PascalCase;
  functions, methods, and variables are snake_case.
- Comments in `.peko` (and `.c`, `.m`, `.peko.h`) files follow strict rules:
  ASCII only (no em/en dashes, arrows, smart quotes, or ellipsis - use `-` or
  rephrase); short declarative sentences; describe what the code does, never what
  it used to do (no "previously", "changed from", "now uses instead"); no comments
  addressed to the reader (no second person, no "TODO: you", no asides). A comment
  describes only the code it sits on.

## GC and FFI

PekoScript runs on a stop-the-world sliding mark-compact GC. Objects move, and a
collection can fire at any allocation. When touching C interop or threaded code,
managed pointers must be handled per the project's GC rules: do not hold a raw
managed pointer across a call that can allocate or block, and park threads around
blocking native calls. If the repo documents GC/FFI rules, read them before editing
managed-memory boundaries.

## pekoui apps

A pekoui app is a native webview plus a bridge. The native side (PekoScript)
registers handlers with `application.on(name, closure)` and pushes events with
`application.emit(name, jsonString)`. The web side calls `peko.invoke(name, params)`
and subscribes with `peko.on(name, cb)`. Web assets build with the JS toolchain
(npm) and the CLI embeds them; the native entry is `[project].entry`.

## Practical tips

- After editing, always `peko test` the file, then `peko build`. A green
  `peko test` is not enough on its own for cross-file or codegen issues.
- `peko --json <command>` emits machine-readable events, useful when scripting.
- Run `peko help <command>` for exact flags before guessing.
