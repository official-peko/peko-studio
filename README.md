# Peko Studio

The native IDE for building [Peko](https://pekoui.com) apps. Peko Studio is
itself a Peko app: a `pekoui` webview shell hosting a React and Monaco editor,
wired to the Peko language server, the build and run loop, the package registry,
and an in-editor AI agent.

## What it does

Editing runs on Monaco with PekoScript support: syntax, themes, semantic tokens,
tabs, breadcrumbs, search, an image viewer, and a Markdown preview. Language
intelligence comes from `peko lsp` over a WebSocket relay the native host
manages, so completions, diagnostics, hover, go-to-definition, and formatting
match what the compiler reports.

Around the editor:

- A Build and Run panel driving the incremental `peko run` dev loop, with output
  and diagnostics routed back into the editor.
- A file explorer with create, rename, delete, and copy-path, plus git status
  decorations, the current branch, and a toolbar.
- A project launcher in the style of Xcode's, opening each project in its own
  window.
- A package manager for browsing the registry and managing a project's
  dependencies.
- An icon builder that edits layered `.pekoicon` documents and exports the
  per-platform icon set.
- A Signing tab, one sub-tab per target platform, showing what each has and what
  it still needs. It registers key files, generates an Android keystore or an
  Apple certificate request, completes the Apple flow from the downloaded `.cer`,
  and registers the App Store Connect key that notarizes a macOS release.
- A Deploy tab for linking the project to a platform app and shipping a release.
- A status-bar account chip that reuses the `peko` CLI session, and per-OS window
  chrome, theme, and layout that persist across launches.
- A first-run setup screen that installs the toolchain when `peko check` reports
  it missing, streaming progress from `peko setup --json`.

## The AI agent

The agent panel wraps an agent CLI rather than reimplementing one. The CLI owns
the loop, the model, and the edits; the panel spawns it, streams its output, and
renders the conversation. Threads persist per workspace and resume by session id.

Five CLIs are supported, and the panel offers whichever are installed:

| CLI | Session | Inline approvals |
|---|---|---|
| Claude Code | one process, messages on stdin | yes |
| Codex | one process per turn, resumed by id | no |
| Gemini | one process per turn | no |
| opencode | one process per turn, resumed by id | no |
| Aider | one process per turn | no |

Claude Code is the only one that hands individual actions back for a decision, so
it is the only one offering per-action Allow and Deny. The others enforce their
own policy for a whole run, and their permission modes are narrower to match.
Adding another CLI means adding an entry in `src/agent/providers.ts` and a branch
in `main.peko`.

Studio ships two skills to whichever agent it runs, installed into an IDE-owned
plugin directory so nothing touches the user's own config. One covers Peko
development (the CLI, the language, pekoui apps, the platform, and app store
submission) and one covers the product style bar. They live in `agent-plugin/`
and are imported at build time, which makes that directory the only place to
edit them.

## Architecture

Peko Studio is one Peko project with two halves.

The native host is `src/main.peko`, the `pekoui` webview shell. It spawns
`peko lsp` and frames LSP between the editor's WebSocket and the server's
`Content-Length` stdio, keeping a single writer per endpoint. It also runs the
dev loop and exposes file, git, account, package, agent, and window operations
over the pekoui bridge.

The frontend is `src/`, React and Monaco, talking to the host through
`@peko/client` (`peko.invoke` and `peko.on`) and to the language server over the
relay WebSocket.

```
src/
  main.peko        native host: webview shell, LSP relay, dev loop, bridges
  App.tsx          top-level UI shell
  editor/          Monaco setup, tabs, explorer, search, previews, languages
  lsp/             JSON-RPC and the PekoScript LSP client
  panel/           build and run, signing, deploy panels
  ide/             launcher, package manager, icon builder, settings, workspace
  agent/           agent panel, provider adapters, plugin installer
  chrome/          titlebar, window controls, theme picker, account chip
  setup/           first-run setup flow
agent-plugin/      the skills bundled with Studio
icon/              app icon sources
```

## Requirements

The Peko toolchain has to be installed, which provides `peko`, `peko lsp`,
`pekoui`, and the platform build toolchains. `peko setup` installs it. Node.js 18
or newer builds the frontend. Studio targets macOS, Windows, and Linux, as
declared in `peko.toml`.

The frontend depends on the `@peko/client` SDK, referenced in `package.json` by
the project-relative path `.peko/client/pekoui`. The build places the SDK there
from the installed `pekoui` package, so a clone works without editing the path.

## Getting started

```sh
npm install
peko run
```

`peko run` starts the framework dev server, points the native window at it so web
edits reload live, and recompiles and relaunches on `.peko` changes with the
route restored.

To produce distributable bundles:

```sh
peko build
peko build --platform macos
peko build --release --platform windows
```

## Building a release

`--release` optimizes and runs each platform's signing step, which is where a
first release build usually stops. What each platform needs:

| Platform | Needs |
|---|---|
| macOS | a Developer ID certificate to sign, and an App Store Connect key to notarize. Without them the build warns and the app is unsigned. |
| Windows | the `[windows]` identity keys in `peko.toml`. Code signing is optional. |
| Linux | nothing; AppImages are not signed. |

The Windows case is the one that fails rather than warns. A Windows release always
packages an MSIX alongside the `.exe`, and the package identity cannot be derived,
so `identity_name`, `publisher`, and `publisher_display_name` have to be present
or the build stops. Studio ships the `.exe`, so the values in `peko.toml` are
placeholders that satisfy the build; replace them with the reserved identity from
Partner Center before submitting to the Microsoft Store.

Signing material is registered from the Signing tab, or with `peko keys`. It lives
in `.peko/keys/` with passwords in the OS keychain, so none of it is committed.

## Repository notes

`assets/`, `dist/`, `build/`, `.peko/`, and `node_modules/` are build output and
are gitignored, as is `peko.lock`.

Take care not to commit signing material or a password file. `.peko/` is ignored,
but a `--password-file` written elsewhere in the tree is not.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, the checks a
change has to pass, and the pull request process. Contributions are accepted
under the MIT License, the same terms as the rest of the project. For anything
larger than a small fix, open an issue before writing code.

## License

MIT. See [LICENSE](LICENSE) for the full text.

Copyright 2026 Peko UI Technologies LLC.

Peko Studio is built with Peko, so the shipped application links the same
vendored native components every Peko app does: BearSSL, webview, and on Android
the native app glue. The bundler writes their attribution into the app as
`OPEN-SOURCE-NOTICES.txt`. Third-party npm packages used by the frontend carry
their own licenses under `node_modules/`.
