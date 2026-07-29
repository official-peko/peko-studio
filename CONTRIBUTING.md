# Contributing to Peko Studio

Peko Studio is the native IDE for building Peko apps — a `pekoui` webview shell
(`src/main.peko`) hosting a React + Monaco frontend (`src/`), wired to the Peko
language server, the build/run loop, the package registry, and an in-editor AI
agent.

Contributions are welcome. This document covers what to expect and what a change
needs to pass before it can be merged.

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under the
MIT License, the same terms as the rest of the project (see [LICENSE](LICENSE)).
You retain copyright in your work; you are granting the same rights to everyone
that the project grants.

Only contribute code you have the right to contribute. Do not paste code from
another project unless its license permits it, and if you do, say so in the pull
request so the attribution can be handled properly.

## Before you start

For anything beyond a small fix, open an issue first and describe the problem.

Much of what looks like a Studio bug is really a toolchain bug — the language
server, the compiler, or the bundler all live in
[peko-tools](https://github.com/official-peko/peko-tools). If the same thing
misbehaves from the `peko` CLI, it belongs there instead. Diagnostics, hovers,
and completions in particular come from `peko lsp`, not from this repository.

Good first contributions: editor and UI fixes, panel and workflow improvements,
keyboard and accessibility gaps, theme work, clearer error surfaces.

Please open an issue before: changes to the native shell in `src/main.peko`, new
native capabilities crossing the bridge, changes to how projects are opened or
stored, and new dependencies.

## Development setup

You need the Peko toolchain installed (it provides `peko`, `peko lsp`, `pekoui`,
and the platform build toolchains) and Node.js 18+.

```sh
npm install          # frontend deps
peko run             # build + launch with the incremental dev loop
```

Note the `@peko/client` dependency in `package.json` is a `file:` path into your
local Peko install. If your install lives elsewhere, point it at your own path
before running `npm install`; do not commit that change.

## Required checks

Run these before pushing:

```sh
npx tsc --noEmit     # type-check the frontend
npm run build        # the Vite production build must succeed
peko build           # the native shell must compile
```

A change that only touches the frontend still needs `peko build` to pass if it
touches the bridge surface, since the native and web sides are wired by name.

## Architecture notes

- `src/main.peko` is the native process: window and menu setup, the LSP relay,
  process spawning, file and git operations, and everything reached over the
  bridge. It is PekoScript, not TypeScript.
- `src/ide/`, `src/panel/`, `src/editor/`, `src/setup/` are the React frontend.
- Native and web talk over the pekoui bridge. Adding a capability means adding
  both a handler in `main.peko` and a caller on the web side; keep the names in
  step.
- Preferences persist natively (`~/.peko-studio/prefs.json`), not in
  `localStorage` — the asset server binds a fresh port each launch, so the web
  origin changes and `localStorage` is effectively ephemeral.

## Commit style

Commit messages are short imperative one-liners describing what the commit does.
Keep the history readable: one logical change per commit, and rebase rather than
merge when updating a branch.

## Pull requests

- Describe what the change does and why. If it fixes an issue, link it.
- Include a screenshot or a short clip for anything user-visible.
- Say which platforms you tested on. Studio ships for macOS, Windows, and Linux,
  and the native shell diverges per platform (window controls, menus, and paths
  especially). A change tested only on one platform is fine — say so, rather
  than implying wider coverage.
- Keep unrelated changes out.

## Reporting bugs

Open an issue with what you did, what you expected, what happened, your
platform, and your `peko --version`. For editor behaviour, say whether the same
thing happens from the CLI — that separates a Studio bug from a toolchain bug.

## Security

Do not report security issues in a public issue. Email
[contact@pekoui.com](mailto:contact@pekoui.com) with the details and give us a
chance to ship a fix before disclosing.

## Conduct

Be straightforward and civil. Critique code, not people. Maintainers may close
or block on conduct grounds.
