# pekoui apps

A pekoui app is a native binary hosting a webview, plus a web frontend. The
native half is PekoScript; the web half is an ordinary JS/TS app built with npm.
The two talk over a bridge.

`pekoui` is a separate package and is not auto-imported:

```peko
import pekoui as ui;
import pekoui::env;
```

Its modules are `app`, `webview`, `assets`, `storage`, `keychain`, `menu`,
`bridge`, `dialog`, and `env`.

## Project shape

`[ui]` in `peko.toml` marks the project as an app.

- `framework` is the web template (`react-ts` by default).
- `server_framework` set means it is an SSR app that can be hosted. Absent means
  a static or on-device app that serves its bundled UI from a loopback server.
- `icon` is a square PNG. `scheme` registers a custom URL scheme for deep links.
- `width` and `height` set the initial window size.
- `[project].target_platforms` decides what `peko build` produces.

## The native half

The entry file named by `[project].entry` builds an `App`, registers handlers,
and runs it:

```peko
import pekoui as ui;

fn main() {
    let application: ui::app::App = ui::app::from_bundle();

    application.on("ide.fs.tree", closure(params: string) => string {
        let parsed: json::JsonValue = json::parse(params);
        if parsed.kind() != "object" {
            return `{"ok":false}`;
        }
        return `{"ok":true}`;
    });

    application.run();
}
```

`App` methods that matter:

- `on(method, closure(string) => string)` registers a handler. The parameter and
  the return value are JSON strings. Parse with `json::parse`, build replies with
  interpolation or the json module.
- `emit(name, data)` pushes an event to the web side. `data` is a JSON string.
- `route()` and `navigate(path)` read and set the current route.
- `webview()` returns the underlying `WebView`.
- `run()` enters the event loop and does not return.

Handlers must not block the event loop. Long work belongs on a thread, emitting
progress events as it goes. A handler that shells out to a build, for example,
should return immediately and stream results through `emit`.

## The web half

Install `@peko/client`. The `peko` object is a proxy: known members pass through,
and anything else becomes a namespace whose methods invoke `<namespace>.<method>`.

```js
import { peko } from '@peko/client'

// Call a native handler.
const tree = await peko.invoke('ide.fs.tree', { path: '/src' })

// Subscribe to a native event. The payload arrives already parsed.
peko.on('ide.fs.change', (data) => {
  console.log(data.path)
})

// peko.storage.get({...}) invokes the native method "storage.get".
const value = await peko.storage.get({ key: 'theme' })
```

Core members: `invoke`, `on`, `off`, `ready`, `connect`, `platform`,
`bridgeStatus`, `titlebar`, `toolbar`, `menu`, `noDrag`, `control`, `window`,
`windows`.

A payload delivered to a `peko.on` callback is **already an object**. Calling
`JSON.parse` on it throws, and a caught throw inside an event handler tends to
present as "no events arriving" rather than as an error.

### Window chrome

Desktop windows are frameless, so the web side draws its own titlebar.

- `peko.window.minimize()`, `.maximize()`, `.close()` drive the host window.
- Declarative equivalents exist as `data-peko-*` attributes, including a drag
  region and a `no-drag` opt-out for interactive elements inside it.
- `peko.windows.open(...)` and `.close(...)` manage secondary windows. On desktop
  a second window is a second process of the same binary sharing the opener's
  bridge; on mobile and web it degrades to a modal or iframe.
- `peko.menu` builds the application menu. On Windows the menu is drawn in HTML
  rather than by the OS.

### Storage caveat

`localStorage` is not durable across launches in a pekoui app. The asset server
binds a fresh port each launch, so the origin changes and per-origin storage is
lost. Persist through a native handler writing to a file under the app's data
directory instead.

## The native bridge for hosted apps

An on-device or static app reaches native APIs over a local socket, with no
platform involvement. An SSR app is different: its backend runs remotely, so it
cannot reach the device directly. The bridge connects them.

- The app's own web server mounts a WebSocket at `/__peko__` on port 3000. That
  path and port are fixed; the load balancer routes only 3000, and the health
  check stays on the app's `healthPath`.
- The device connects to `wss://<slug>.serve.pekoui.com/__peko__` carrying a
  short-lived ES256 token, and bridges the server's requests to its local native
  socket.
- The server is the consumer and the device is the provider. The usual flow is a
  server-to-device `rpc`, executed on the device, answered with a `result`.
  Native events flow device to server as `event`.

Tokens:

- A shipped app does not use developer credentials. The platform provisions an
  app bridge credential on every `peko deploy server` and injects it as the
  `PEKO_BRIDGE_KEY` environment variable, which the backend reads to mint tokens
  for its own end-user devices. There is nothing for the CLI to manage.
- For manual use and the dev device, `peko bridge token` mints one against the
  linked app. It needs a session and a verified email.
- CloudFront verifies the token at the edge before it reaches the app, and
  injects `X-Peko-Uid`, `X-Peko-Device`, `X-Peko-App`, and `X-Peko-Verified`.
  Only CloudFront can reach the origin, so those headers can be trusted.

Practical notes: keep server handlers stateless per message, heartbeat about every
30 seconds to detect a half-open socket, and back off on reconnect. A native
WebSocket client has to persist and resend the load balancer's stickiness cookie
across reconnects. A reconnect flood is metered against the app's server credits
and can trip its kill switch.

## Building and shipping

`peko run` is the dev loop and needs a `dev` script in `package.json`. It starts
the framework dev server and points the native window at it, so web edits reload
through the framework's own hot reload while `.peko` edits recompile and relaunch
with the route restored.

`peko build` produces distributable bundles for the declared platforms. See
`platform.md` for signing, store submission, and hosting.
