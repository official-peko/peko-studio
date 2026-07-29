---
name: peko-development
description: Use when working in a PekoScript project (any repo with a peko.toml or .peko files) - building, running, type-checking, formatting, managing dependencies with the peko CLI, writing PekoScript, building pekoui apps, signing, publishing packages, and deploying to the Peko platform.
---

# Peko development

PekoScript is a statically typed, LLVM-compiled, garbage-collected language that
builds native binaries for macOS, Windows, Linux, iOS, and Android. Source files
use the `.peko` extension. A project is defined by a `peko.toml` at its root. The
`peko` CLI drives compiling, running, testing, formatting, dependency
management, signing, publishing, and deploying.

## Orient before changing anything

Read `peko.toml` first. It decides what every command does.

- `[project]` has `name`, `version`, `bundle` (reverse-DNS id), `entry` (the main
  source file), and `target_platforms` (which OSes `peko build` produces).
- `[ui]` present means it is an app with a web frontend. `framework` is the web
  template; `server_framework` set means it is an SSR app that can be hosted.
- `[package]` plus `[lib]` instead of `[project]` means it is a library, and it
  is published rather than built into an app.
- `[dependencies]` lists packages. `peko.lock` pins resolved versions; never
  hand-edit it.

`peko project show-info` prints the resolved configuration. Source lives under
`source/` by convention, with the entry named in `peko.toml`.

There are three project shapes, and they behave differently throughout:

| Shape | Marker | `peko build` produces | Ships via |
|---|---|---|---|
| UI app | `[ui]` | a bundle per target platform | `peko deploy app`, or `deploy server` for SSR |
| CLI program | no `[ui]` | one host binary | run or distribute the binary |
| Library | `[package]` + `[lib]` | nothing by default | `peko deploy package` |

## The core loop

Use the cheapest check that covers the change, then escalate.

1. `peko test <file.peko>` type-checks one file and prints diagnostics. It runs
   the parser and the semantic simulator and stops, so there is no codegen and
   it is fast. Use it constantly while editing. `--os` and `--arch` check a
   different target's platform imports.
2. `peko build` builds the whole project and catches what single-file checking
   cannot: cross-file errors, linking, and codegen. `--platform <os>` builds one
   platform instead of every declared target.
3. `peko run` builds and runs. For a CLI project this compiles then executes
   once. For a UI project it is a dev loop (see below).
4. `peko format <files...>` normalizes indentation and spacing. Run it on every
   `.peko` file you edited before you finish. `--check` reports without writing.

A green `peko test` is not sufficient on its own. After editing, test the changed
files, then build. Fix diagnostics before moving on.

## Running a UI app

`peko run` on a UI project is an incremental dev loop, not a one-shot build:

- It starts the web framework's own dev server with `npm run dev`, and the native
  window loads that dev URL rather than bundled assets. JS, CSS, and component
  edits reload through the framework's hot reload with no rebuild.
- Editing `.peko` source recompiles the native binary incrementally and relaunches
  the window, restoring the route that was open.
- The project stays in memory across rebuilds, so external packages stay compiled
  and only changed files rebuild.

This requires a `dev` script in `package.json`. Without one the command stops and
tells you to use `peko build`. `peko run --devtools` opens a diagnostics window
that drives the same loop.

## Dependencies

- `peko add <package>` writes the dependency into `peko.toml` and installs it.
  `peko add std@0.1.3` pins inline; `--version <req>` also works; `--path <dir>`
  adds a local path dependency.
- `peko remove <package>` removes one. `peko install` resolves and locks.
  `peko update` re-resolves and refreshes `peko.lock`.
- Dependencies resolve automatically at the start of `peko build` and `peko run`.

`std` and `pekoui` are installed globally by `peko setup`, so they resolve without
being vendored into the project.

## Language essentials

Full detail is in `references/pekoscript.md`. The rules that matter most:

- `Type?` is an optional. Do not expand it to `Option<Type>` by hand. Check with
  `.is_value()` and read with `.unwrap()`.
- Managed pointers are `pointer<T>`.
- Classes and constants are PascalCase. Functions, methods, and variables are
  snake_case.
- A field that a method reassigns needs `[mutates]` on the field.
- `import std::fs;` imports a module. `std::core` and `std::collections` are
  auto-imported and used bare; `std::runtime`, `std::json`, and `std::xml` are
  auto-imported but used through their prefix. Everything else needs an explicit
  import. `import pekoui as ui;` aliases a whole package.
- Reserved words cannot be used as identifiers or FFI parameter names. `fn`,
  `in`, and `arch` are the ones that bite most often; a `let arch` produces a
  cascade of unrelated-looking parse errors.

### Comment rules (enforced)

Comments in `.peko`, `.c`, `.m`, and `.peko.h` files follow strict rules:

- ASCII only. No em dashes, en dashes, arrows, smart quotes, or ellipsis
  characters. Use `-` or rewrite the sentence.
- Short declarative sentences describing what the code does.
- Never describe history. No "previously", "changed from", "now uses instead".
- Never address the reader. No second person, no "TODO: you", no asides.
- A comment describes only the code it sits on.

## Garbage collection and FFI

PekoScript uses a stop-the-world sliding mark-compact GC. Objects move, and a
collection can fire at any allocation. When touching C interop or threaded code:

- Do not hold a raw managed pointer across a call that can allocate or block.
- Park threads around blocking native calls.
- On Android, UI-thread work must park the GC the same way.

Getting this wrong produces crashes that surface far from the cause, usually a
null vtable inside an unrelated dispatch. If the repo documents GC or FFI rules,
read them before editing a managed-memory boundary.

## When something looks stale or wrong

- Build output not reflecting a CLI or toolkit change: reinstall peko or mirror
  the toolkit, then `peko build --clean`. Bundling config files under
  `.peko/bundling/configfiles/` are generated once and not regenerated unless you
  pass `--regenconfig`.
- A compiler panic on an unrelated standard-library function usually means a
  stale incremental cache. `peko build --clean` clears it.
- `peko check` verifies the toolchain install; `peko check --rehash` re-certifies
  it after you change files under the Peko root.

## Platform invariants

These hold whenever the conversation reaches the platform, and they are worth
stating correctly the first time:

- **Peko does not submit to the app stores.** It prepares a release and produces a
  downloadable bundle that the user submits themselves, in their own developer
  accounts. Never say Peko will file, upload, or submit for them.
- **Entitlements are enforced server-side.** Explain what a plan requires; do not
  imply the CLI or Studio decides access.
- **The user owns their store accounts, signing material, and store credentials.**
- **Credits are real money.** Hosting burns server credits; `peko deploy app` and
  asset generation burn deploy credits. Never call a charged action free.
- **Some actions are one-way.** "Finish draft" in the deploy wizard deletes the
  working sources and keeps only the packed zip.

Name the exact CLI command for anything the CLI does, and the exact page for
anything that is browser-only. If a surface is still being provisioned, say so
rather than guaranteeing it.

## Looking things up

Work from what is on the user's machine and from live sources, never from a
checkout of Peko's own repositories. The user will not have those.

- Installed dependency source is under
  `~/.Peko/registry/src/<name>/<name>-<version>/`. Read it to confirm a package's
  real API instead of guessing at one.
- `peko help <command>` is the authoritative flag list.
- `peko project show-info` resolves the current project's configuration.
- The platform is at `app.pekoui.com`; package pages are under `/packages`.
- Studio should read live endpoints from `/api/cli/config` rather than hardcoding
  a registry URL.

## References

Load the one you need rather than reading all of them:

- `references/cli.md` - every command, its flags, and when to reach for it.
- `references/pekoscript.md` - the language in depth: types, classes, traits,
  optionals, generics, modules, FFI.
- `references/pekoui.md` - UI apps: the native and web halves, the bridge,
  the `peko.*` client API, windows, menus, and the native bridge for hosted apps.
- `references/platform.md` - accounts, tiers and credits, apps and capabilities,
  hosting, and packages including gated ones.
- `references/app-stores.md` - signing keys per store, `peko deploy app`, the
  deploy wizard, the handoff bundle, and how the user submits to each store.
- `references/environment.md` - `peko setup`, the `~/.Peko` layout, toolchains,
  and what a working install contains.

Run `peko help <command>` for exact flags before guessing. `peko <command> --json`
emits machine-readable events, which is what Peko Studio consumes.
