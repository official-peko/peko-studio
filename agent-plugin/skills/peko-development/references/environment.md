# The Peko environment

Everything a machine needs to build Peko projects lives under `~/.Peko`, laid down
and kept current by `peko setup`. `PEKO_ROOT_PATH` overrides the location.

## Installing and updating

```
peko setup                                    # install, or refresh what changed
peko setup --check                            # report available updates, then exit
peko setup --force                            # reinstall every component
peko setup --windows --accept-microsoft-license
peko setup --sdk-version v2.0.3               # pin one component to a release
```

Setup resolves the newest stable release of each repository at run time. It never
targets a hardcoded version, and it skips prereleases, so a release candidate is
only installed by asking for it with `--peko-version` or `--sdk-version`.

Update mode is automatic. Setup resolves both releases first, compares them to the
recorded manifest, and skips the large downloads for anything unchanged, which
turns a no-op re-run into a few seconds instead of a few gigabytes. `--force`
overrides that.

`--json` emits newline-delimited progress events including per-megabyte download
percentages. Peko Studio's setup screen is built on this.

## What setup does, in order

1. Installs the Compiler SDK, which is everything except the toolchains.
2. Places the running CLI at `Compiler/bin/peko/peko` so later steps can call it.
3. Installs the linux and android toolchain payloads.
4. Links the Apple SDKs through `xcrun`, on a macOS host only. Apple's license
   does not allow redistributing them, so this is a link to Xcode's copy rather
   than a download, and Apple targets cannot be built on a non-Mac host.
5. Installs the Windows toolchain through xwin, if requested. The MSVC CRT and
   Windows SDK are under the Microsoft license, so this is opt-in and gated on
   `--accept-microsoft-license`. This step reaches Microsoft's servers and can
   fail transiently; it is optional, so setup warns and carries on.
6. Installs the toolchain descriptors, applied last so the canonical
   `toolchain.toml` files win over any copy bundled inside a payload.
7. Installs `std` and `pekoui` globally.
8. Writes `versions.json`, the manifest the toolchain resolver reads.
9. Configures PATH, then certifies the install with `peko check --rehash`.

## Layout

```
~/.Peko/
  Compiler/
    bin/            aapt2, zipalign, bundletool.jar, and peko/peko
    bundling/       per-platform bundling templates
    include/        headers exposed to PekoScript
    java/           the bundled JDK, used for Android signing and packaging
    llvm18/         clang and lld, one directory per host platform
    toolchains/     android, ios, linux/{arm,x86_64,gtk}, macos/{arm64,x86_64}, windows
    THIRD-PARTY-NOTICES.txt
  registry/         unpacked package sources, shared by every project
  global/           the global manifest and lock for globally installed packages
  apps/             per-app data directories used by built apps
  env               the PATH shim sourced from the shell profile
  versions.json     the install manifest
```

Each toolchain carries a `toolchain.toml` describing its target triple, compile
flags, includes, and link step. That file is the source of truth for how a target
is built, and it ships from the CLI release rather than the SDK payload.

Some toolchains reference shared sibling directories rather than carrying their
own copy: the linux toolchains include GTK and WebKit headers from
`toolchains/linux/gtk`, and the Apple toolchains link OpenSSL archives from
`openssl_libs` directories. A build that fails to find `JavaScript.h` or
`libssl.a` usually means one of those shared trees is missing, which `peko setup
--force` restores.

## Verifying an install

```
peko check              # verify expected directories and binaries are present
peko check --rehash     # re-certify after changing files under the root
peko toolchain list     # parse every installed toolchain.toml and report failures
```

The root is hashed at install time, and the CLI refuses to run against a root that
looks corrupted. After hand-editing anything under `~/.Peko`, re-certify with
`peko check --rehash` or the next command will report a corrupted installation.

## Stale-state checklist

Build output that does not reflect a change is almost always one of these:

- The CLI or the toolkit changed but was not reinstalled. Reinstall, then
  `peko build --clean`.
- Bundling configuration under `.peko/bundling/configfiles/` is generated on first
  build and never refreshed. `peko build --regenconfig` rewrites the templates,
  discarding local edits to them.
- A stale incremental cache. This can present as a compiler panic inside an
  unrelated standard-library function rather than as a clear error.
  `peko build --clean` clears it.
- A project moved or was renamed on disk. The incremental cache keys on absolute
  paths, so entries from the old path linger until cleaned.
