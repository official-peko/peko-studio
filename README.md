# Peko Studio

The native IDE for building [Peko](https://pekoui.com) apps. Peko Studio is
itself a Peko app — a `pekoui` webview shell hosting a React + Monaco editor,
wired to the Peko language server, build/run loop, package registry, and an
in-editor AI agent.

## Features

- **Code editor** — Monaco with first-class PekoScript support (syntax, themes,
  semantic tokens), tabs, breadcrumbs, search, an image viewer, and a Markdown
  preview.
- **Language intelligence** — a full LSP client talking to `peko lsp`
  (completions, diagnostics, hover, go-to-definition, formatting) over a
  dedicated WebSocket relay the native host manages.
- **Build & run** — a Build/Run panel driving the incremental `peko run`
  dev loop, with live output and diagnostics routed back into the editor.
- **Explorer with git** — a file tree with create/rename/delete/copy-path, git
  status decorations and the current branch, plus a toolbar (new file/folder,
  collapse, refresh).
- **Project launcher** — an Xcode-style launcher (recent / new / open) that
  opens each project in its own window.
- **Package manager** — browse and search the Firestore-backed Peko registry and
  manage a project's installed dependencies.
- **Icon builder** — a layered app-icon editor that exports the per-platform
  icon set (`.pekoicon`).
- **AI agent** — a chat panel wrapping an agent CLI over streaming JSON, with
  markdown, persisted threads/session-resume, and inline allow/deny approvals.
- **Account & sync** — a status-bar account chip (reuses the `peko` CLI session)
  and native, per-OS window chrome and theming that persist across launches.

## Architecture

Peko Studio is a single Peko project with two halves:

- **Native host — `src/main.peko`.** The `pekoui` webview shell. It spawns
  `peko lsp` as a child process and frames LSP between the editor's WebSocket
  and the server's `Content-Length` stdio (single writer per endpoint), runs the
  `peko run` dev loop, and exposes file, git, account, package, and window
  operations to the frontend over the pekoui bridge.
- **Frontend — `src/` (React + Monaco).** The editor UI, talking to the host
  through the `@peko/client` bridge (`window.peko.invoke` / `.on`) and to the
  language server over the relay WebSocket.

```
src/
  main.peko        native host: webview shell + LSP relay + dev loop + bridges
  App.tsx          top-level UI shell
  editor/          Monaco setup, tabs, explorer, search, previews, languages
  lsp/             JSON-RPC + PekoScript LSP client
  panel/           Build/Run panel
  ide/             project launcher, package manager, icon builder, settings
  agent/           AI agent panel (protocol, plugin, transport)
  chrome/          titlebar, window controls, theme picker, account chip
  setup/           first-run setup flow
agent-plugin/      agent skills bundled with Studio
icon/              app icon sources (.pekoicon)
```

## Requirements

- The **Peko toolchain** installed (provides `peko`, `peko lsp`, `pekoui`, and
  the platform build toolchains). See https://pekoui.com.
- **Node.js** (18+) for the Vite frontend build.
- macOS, Windows, or Linux (declared in `peko.toml`).

> The frontend depends on the `@peko/client` SDK, referenced in `package.json`
> by a `file:` path into the local Peko install
> (`~/.Peko/registry/src/pekoui/.../client`). After cloning, point that path at
> your own Peko install if it differs.

## Getting started

```sh
npm install          # frontend deps
peko run             # build + launch with the incremental dev loop
```

To produce distributable bundles for the declared platforms:

```sh
peko build           # or: peko build --platform=macos|windows|linux
```

`peko run` builds the web app (Vite), embeds it, launches the native window, and
hot-reloads on `.peko` and frontend changes.

## Repository notes

- `assets/`, `dist/`, `build/`, `.peko/`, and `node_modules/` are build output
  and are gitignored.
- `peko.lock` is gitignored because the project resolves `pekoui` via a local
  path dependency, so the lockfile is environment-specific.
