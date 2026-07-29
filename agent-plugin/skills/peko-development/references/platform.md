# The Peko platform: accounts, apps, hosting, packages

Everything that leaves the machine. The platform is `https://app.pekoui.com`
unless `PEKO_PLATFORM_URL` or `--base` overrides it. Store submission is covered
separately in `app-stores.md`.

Two invariants to hold throughout:

- Entitlements are enforced on the server. Explain what a plan requires, but never
  imply the CLI or Studio decides access.
- Credits are real money. Be precise about what charges them and never describe a
  charged action as free.

## Session

```
peko login      # opens a browser, receives a one-time code on a loopback server
peko whoami     # uid, email, display name, role, tier
peko logout     # clears the stored session
```

Accounts are Firebase-backed. Sign-in is Google OAuth, email and password, or a
passwordless email link, at `/auth/signup` and `/auth/login`.

`peko login` binds a random localhost port and opens a consent page. The platform
mints a single-use five-minute code, delivers it to the loopback callback, and the
CLI exchanges it for a session stored in the OS keychain. Later commands send a
fresh ID token as a bearer.

Signing out on the web revokes the account's refresh tokens, which invalidates a
CLI session established earlier. The CLI clears the stored credentials and asks
for `peko login` again.

**Publishing packages and app distribution require a verified email.** That is a
browser step and cannot be done from the CLI.

## Tiers and credits

Two tiers: `free` and `pro`. Pro is a Stripe subscription.

| Cap | free | pro |
|---|---|---|
| Apps owned | 1 | 5 |
| Apps running a hosted server | 1 | 3 |
| Store-release generations per period | 0 | 20 |

Free tier can create an app and can host. Never describe hosting as Pro-only.

Two separate credit pools, both of which accumulate rather than reset:

- **Server credits** fund hosting: metered runtime plus egress.
- **Deploy credits** fund `peko deploy app` work: asset generation, remote Apple
  builds, AI drafting, and the flat distribution fee. This pool can go negative,
  which blocks further paid actions until it is topped up.

Grants: free tier gets 50 server credits per month and 20 deploy credits per year.
Pro gets a custom monthly amount of each, defaulting to 200 server and 40 deploy,
with a minimum plan of 50 credits per month.

A credit costs $0.10 and is worth $0.08 of compute. Buy or subscribe at
`/account/credits`.

For "how long will my server run": Fargate runtime is about $0.0148/hr on free and
$0.0247/hr on pro, and credits per hour is that figure divided by $0.08. Egress is
$0.085/GB, roughly 0.85 credits/GB. When a server app's credits reach zero a kill
switch pauses it until more are added. An optional per-app monthly cap is
available.

## Apps

An app is created in the browser at `/apps/new`. It needs a display name of 1 to
60 characters. Two optional capabilities are set at creation and decide how the
app can be deployed:

| Capability | Meaning | Command |
|---|---|---|
| server | runs a hosted SSR backend | `peko deploy server` |
| distribution | ships native binaries to stores | `peko deploy app` |

Each app has one owner; another account cannot see that it exists. The platform
assigns a random 12-character slug used for `<slug>.serve.pekoui.com`. The slug is
neither user-chosen nor the app id.

```
peko apps                  # list this account's apps
peko apps show app_1a2b3c  # name and capabilities for one
peko link app_1a2b3c       # write [project].app_id into peko.toml
peko link                  # show the current link
```

`peko link` is a local edit to `peko.toml`. It needs no login and no network.
Check the capability before deploying rather than after a failure. `apps show`
distinguishes an app that does not exist from one owned by another account, which
tells a stale link apart from being signed in as the wrong user.

Environment variables are set from the app dashboard. Keys must match
`^[A-Za-z_][A-Za-z0-9_]*$`, with a limit of 50 variables and 32 KB total. Secrets
are stored server-side, never in the repo.

Server provisioning is still being wired. Treat hosting as available but maturing,
and do not promise instant provisioning.

## Hosting a server app

An app with the server capability runs a Dockerized standalone web build on the
platform's infrastructure, behind a CDN, at a stable
`https://<slug>.serve.pekoui.com`. DNS is created automatically at deploy.

1. Set `[ui].framework = "server"` in `peko.toml` and make sure
   `[project].app_id` is linked.
2. Run `peko deploy server`. The CLI builds the web app with `npm run build`,
   packages the standalone output into a Docker artifact, and hands it over. The
   platform builds the container and runs it.
3. The CLI polls for status and prints the URL once the app is live.

Requirements: `[ui].framework` set to the SSR id itself. Next must emit a
standalone build, which `peko project new` configures. Supported frameworks are
Next.js, Nuxt, SvelteKit, Remix / React Router, Astro, and Angular. The CLI emits
the matching build and Dockerfile per framework, and the container listens on
`0.0.0.0:3000`.

Flags: `--app-id` for a one-off target, `--health-path` when the app does not
return 2xx-3xx on `/`, and `--no-wait` to start and exit.

Running the server burns server credits by metered runtime and egress. Device
clients reach native APIs at `wss://<slug>.serve.pekoui.com/__peko__`; see
`pekoui.md`.

## Packages

### Installing

```
peko add sockets           # add to peko.toml and install
peko add pekoshots@1.2.0   # pin inline
peko install               # resolve, download, verify, lock
```

Resolution reads a public index and downloads each `.pkpkg`, verifying its
checksum, then writes `peko.lock`. `peko build` and `peko run` resolve
automatically.

Installed sources are unpacked under `~/.Peko/registry/src/<name>/<name>-<version>/`.
That is real, readable source, and it is the right place to check a dependency's
actual API rather than guessing.

The registry base URL is still marked a placeholder in the CLI. Read live
endpoints from `/api/cli/config` rather than hardcoding one.

### Browsing

The web index is at `/packages`, with detail pages at `/packages/<name>` showing
versions, README, and keywords. Studio's Browse tab uses the same public JSON.

### Gated packages

Some packages are proprietary prebuilt bundles that need a paid entitlement.
Pekoshots is the current example.

From the user's side this is transparent: run `peko add <name>` as usual. When the
public download is absent and the user is signed in, the CLI requests a
short-lived signed URL with its bearer token, downloads the bundle, and verifies
the hash. An anonymous user only gets public packages.

Requirements are a signed-in session and a Pro plan, both enforced server-side. A
gated bundle is keyed by toolchain version, and one bundle covers every OS target.

Resolving and locking work without being signed in, because the metadata is
public; only the bytes are gated. Map the failures directly:

| Result | Meaning | Fix |
|---|---|---|
| 401 | not signed in | `peko login` |
| 403 `paid` | needs Pro | upgrade at `/account/credits` |
| 404 | no bundle for that toolchain | check the toolchain version |
| 429 | rate limited | retry later |

### Publishing

A library is a `peko.toml` with `[package]` and `[lib]`. Only a package can be
published.

```
peko verify          # pack in memory and check, writing nothing
peko deploy package  # pack, verify, upload
```

`verify` reports hard errors that make a package unpublishable and warnings for
missing registry-quality fields. It is the same check publishing runs, so run it
first.

The upload goes through a handshake: request a slot, PUT the container to a signed
URL, then signal completion. The server reads the name, version, and dependencies
from the embedded `peko.toml`, validates them, computes the checksum, and rejects
a duplicate version. The version is then `pending` admin review and is published
to the index once approved. Maximum package size is 50 MB. A published version
cannot be overwritten; bump the version instead.

`/packages/publish` accepts a drag-and-dropped `.pkpkg` built by the CLI as a web
alternative.

A `.pkpkg` is a container with a 32-byte header, the embedded `peko.toml`, a
zstd-compressed tar payload, and an optional signature trailer. The CLI builds and
verifies them; they are not hand-edited.

### Prebuilt (source-hidden) packages

`peko build --prebuild` compiles a library for every platform into one `.pkbundle`
of cross-compiled objects, definition-only stubs, FFI headers, and
`prebuilt.toml`. This works because generics compile once, so a prebuilt object
serves any instantiation. `--target macos-arm,linux-x86_64` narrows the set.

## App icons

```
peko icon show      # resolved source and target platforms
peko icon generate  # render into each platform's size set
```

The source is one square PNG from `[icon].source`, or `[ui].icon` when there is no
`[icon]` table. `[icon].project` names an editable layered `.pekoicon` that
Studio's icon builder saves. Per-platform overrides replace the source for one
platform, and Android adaptive icons come from a foreground and background pair.
