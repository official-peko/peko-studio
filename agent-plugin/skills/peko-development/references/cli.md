# peko CLI reference

Every command the CLI exposes. Run `peko help <command>` for the authoritative
flag list; this file explains what each one is for and when to reach for it.

Global behavior: `--json` makes a command emit newline-delimited JSON events
instead of prose. Peko Studio drives the CLI this way.

## Working on code

### `peko test <file.peko>`
Type-checks one file and prints diagnostics. Runs the parser and the semantic
simulator, then stops. No object file, no binary. This is the fast inner-loop
check.

- `--os <android|ios|linux|macos|windows>` and `--arch <arm|x86_64>` decide which
  platform-specific imports the checker walks. Defaults to the host.

### `peko build`
Builds the project. A CLI project produces one host binary. A UI project produces
a bundle for every OS in `[project].target_platforms`: Android APK, iOS `.app`,
Linux AppImage, macOS `.app`, Windows `.exe`.

- `--platform <os>` builds a single platform, overriding the declared list.
- `--release` builds optimized and runs each platform's release signing step.
- `--regenconfig` regenerates the templates in `.peko/bundling/configfiles/`.
  They are generated on first build and never refreshed after that, so a change
  to bundling config needs this flag. It overwrites local edits.
- `--demo` includes `demo { ... }` blocks and demo-scoped dependencies, used for
  store-asset generation. A normal or release build omits them.
- `--prebuild` prebuilds the enclosing library for all platforms into one
  uploadable `.pkbundle` (cross-compiled objects, definition-only stubs, FFI
  headers, `prebuilt.toml`). This is how a proprietary package ships without
  source. `--target macos-arm,linux-x86_64` narrows the platform list.

Headless Apple signing, for CI runners with no keychain: `--p12`,
`--p12-password-file`, `--provisioning-profile`, `--entitlements`,
`--installer-p12`, `--installer-p12-password-file`. When `--p12` is given it wins
over any registered `peko keys` entry. Prefer the `-file` variants so secrets stay
out of the process arguments.

### `peko run`
Builds and runs. CLI projects compile then execute once. UI projects enter the dev
loop described in the main skill, which needs a `dev` script in `package.json`.

- `--release` builds optimized.
- `--demo` runs in demo mode.
- `--devtools` opens a diagnostics window that drives the same loop.

### `peko compile <file.peko>`
Compiles a single file straight to an object or a binary, bypassing the project
system. Use it for one-off files and for inspecting codegen; use `peko build` for
anything with more than one file.

- `--object` stops after the object file. `--shared` produces a shared library.
- `--emit-ir` writes the LLVM IR alongside the output.
- `--print-linked` prints every file linked into the binary.
- `--os`, `--arch`, `--output`.

### `peko format <files...>`
Re-indents to bracket depth, trims trailing whitespace, collapses runs of blank
lines. Only leading indentation is rewritten, so comments and string contents
survive exactly. Formats in place by default.

- `--check` reports unformatted files and writes nothing, exiting non-zero if any
  would change. `--stdout` prints instead of writing.

### `peko clean`
Removes the project's build cache and output. The first thing to run when a build
fails: a stale incremental cache presents as a compiler panic in codegen or an
unrelated standard-library function, or as an error against code you did not
touch, so ruling it out costs one rebuild and saves a false trail.

It is its own command. `peko build --clean` is not a thing: `build` takes
`--release`, `--platform`, `--regenconfig`, `--demo`, `--prebuild`, `--target`,
and `--web-dist`, and it ignores a flag it does not know instead of rejecting it.
So `peko build --clean` exits 0 after an ordinary incremental build, having
cleaned nothing — it reads as a successful clean build and is not one. Run
`peko clean`, then `peko build`.

### `peko search`
Text search and replace across the project. Exists for the IDE; prefer normal
search tools when working in a terminal.

- `--query`, `--include`, `--exclude`, `--replace`, `--root`.

### `peko clangflags`
Prints the clang flags peko_core would pass to the C compiler for a target.
Useful when debugging a native build. Takes `--os` and `--arch`.

## Project and dependencies

### `peko project <subcommand>`
- `new` scaffolds a project. Interactively it prompts for type, name, bundle id,
  and version. Non-interactively pass `--name` and `--type <ui|cli|package>`.
  Other flags: `--bundle`, `--version`, `--framework` (web template, default
  `react-ts`), `--dir`, `--force`, and `--no-ui` as shorthand for `--type cli`.
- `show-info` prints the resolved configuration.
- `show-icon`, `show-assets`, `add-asset <path>`, `remove-asset <name>`.

After scaffolding, change a project by editing `peko.toml` directly.

### `peko add <package>`
Writes the dependency into `[dependencies]`, preserving file formatting, then
re-resolves and refreshes `peko.lock`. With no version the requirement is `*`.

- `peko add std@0.1.3` pins inline. `--version <req>` does the same.
- `--path <dir>` adds a local path dependency instead of a registry one.
- `--global` installs into the global scope under the Peko root rather than the
  project.

### `peko remove <package>` / `peko install` / `peko update`
`remove` drops a dependency and re-resolves. `install` resolves, downloads,
verifies each `.pkpkg`, unpacks into the shared source cache, and writes
`peko.lock`. `update` re-resolves and refreshes the lock. `build` and `run`
resolve automatically, so `install` is only needed on its own.

### `peko verify [file.pkpkg]`
Scans a package container and reports its header, embedded `peko.toml`, and
packed source tree, listing hard errors and registry-quality warnings. With no
file it packs the current project in memory and verifies that, which is the same
check publishing runs. Exits non-zero on any error.

## Environment

### `peko setup`
Installs or updates the whole development environment under `~/.Peko`. Covered in
`environment.md`.

- `--peko-version <tag>` and `--sdk-version <tag>` pin a specific release; both
  default to the latest.
- `--windows` plus `--accept-microsoft-license` adds the MSVC CRT and Windows SDK
  through xwin.
- `--force` reinstalls every component. `--check` reports whether an update is
  available and exits. `--json` emits progress events.

### `peko check`
Deep checkup of the installation, verifying expected directories and binaries.
`--rehash` re-certifies the root, which is needed after changing files under it.

### `peko toolchain list`
Loads every installed toolchain's `toolchain.toml` and reports which parse and
which fail.

### `peko version`
Prints the CLI version.

## Platform and distribution

Accounts, apps, hosting, and packages are covered in `platform.md`. Signing keys
and store submission are covered in `app-stores.md`.

- `peko login` / `peko logout` / `peko whoami` manage the stored session.
- `peko link [app-id]` writes `[project].app_id`. A local edit, no network.
- `peko apps [list|show <id>]` lists or shows the account's platform apps and
  their capabilities.
- `peko keys <add|generate|p12|verify|list|remove|install|set-password>` manages
  signing material.
- `peko deploy <app|package|server>` ships an app, publishes a library, or
  deploys an SSR app to hosting.
- `peko bridge token` mints a native-bridge token for a device.
- `peko icon <show|generate>` renders the app icon set.
- `peko demo [name]` runs the app's demo shots to verify the automation flow.
