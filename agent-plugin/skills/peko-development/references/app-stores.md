# Shipping to the app stores

**Peko prepares a release. The user submits it themselves.** The platform builds
the artifacts, generates store assets, drafts the listing text, and packs
everything into a downloadable zip. Uploading that to Apple, Google, or Microsoft
happens in the user's own developer accounts. Never tell a user that Peko will
file, upload, or submit on their behalf.

## Signing keys, per store

Signing material belongs to the user. Peko can generate it, register it, and use
it, but the user owns it and Peko never holds store credentials.

`peko keys verify` reports what each platform requires. Apple and Android must be
signed to ship. Windows and Linux are covered below.

### Apple: App Store and Mac App Store

Prerequisite: an Apple Developer Program membership, which is a paid annual
enrollment done at developer.apple.com.

Both steps below work from any host, so an Apple certificate can be produced on
Windows or Linux without a Mac.

```
# 1. Generate a private key and a certificate signing request.
peko keys generate --platform apple --email you@example.com

# 2. Upload the .certSigningRequest at developer.apple.com under Certificates,
#    choose Apple Distribution, and download the .cer it issues.

# 3. Pair that .cer with the key kept from step 1 into the .p12, and register it.
peko keys p12 --platform ios --cer downloaded.cer --password-file pw.txt
```

For the macOS App Store you also need the Mac Installer Distribution certificate,
which signs the `.pkg`. Repeat step 2 for that certificate type, then:

```
peko keys p12 --platform macos --cer installer.cer --installer --password-file pw.txt
```

iOS additionally needs a provisioning profile, which is created in the developer
portal and cannot be generated locally. Register it alongside the certificate:

```
peko keys add --platform ios --cert dist.p12 --profile app.mobileprovision --password secret
```

Notarization applies to macOS distributed outside the App Store. It uses an App
Store Connect API key: `--notary-issuer`, `--notary-key-id`, and `--notary-p8`.

### Google Play

Prerequisite: a Play Console account, which is a one-time paid registration.

```
peko keys generate --platform android --password-file pw.txt
```

That creates a PKCS#12 upload keystore using the bundled JDK and registers it, so
nothing has to be installed first.

Back this file up and keep the password. Play ties the app listing to the upload
key, and updates cannot be signed with a different one. Losing it means a support
process with Google, not a regenerate.

Play App Signing means Google holds the actual app signing key and the user keeps
only the upload key. Accept it on the first upload.

### Microsoft Store

**No code-signing certificate is required.** The Store re-signs the `.msix` on
submission. Do not tell a user to buy an Authenticode certificate for a Store
release.

What is required is the package identity from Partner Center, which cannot be
derived and must be copied into `peko.toml`:

```toml
[windows]
identity_name = "Contoso.Todo"
publisher = "CN=ABCDEF01-2345-6789-ABCD-EF0123456789"
publisher_display_name = "Contoso"
```

Each field is optional at parse time so a partial table does not break a project
that targets other platforms, but a Windows release build fails without all three.

An Authenticode certificate is only needed to distribute a `.exe` outside the
Store, where signing is optional and an unsigned binary still runs:

```
peko keys add --platform windows --pfx codesign.pfx --password secret
```

### Linux

No signing model and no consumer store target. The build produces an AppImage.
Store assets are still generated for it, but there is no Linux store folder in the
handoff bundle.

### Signing in CI

`peko build --release` takes signing material directly, bypassing the keychain and
any registered key:

```
peko build --release --platform macos \
  --p12 dist.p12 --p12-password-file p12.pw \
  --installer-p12 installer.p12 --installer-password-file installer.pw
```

Use the `-file` password variants so secrets stay out of the process arguments.

## Step 1: build the store artifacts

The app must be linked to a platform app that has the distribution capability.

```
peko deploy app
```

This produces two builds per platform:

- a generation build (`peko build --demo`): debug, demo and pekoshots content
  included, unsigned. The device farm runs it to capture store screenshots and
  recordings.
- a submission build (`peko build --release`): signed and store-ready.

Both are packed into `build/deploy/<app>-<version>.pkdeploy` and uploaded.

Two archives are easy to confuse, and the distinction matters:

| Archive | Direction | Purpose |
|---|---|---|
| `.pkdeploy` | CLI uploads it | internal transport to the platform. Never submitted to a store. |
| `<AppName>-<version>-stores.zip` | user downloads it | the handoff bundle that gets submitted. |

`peko deploy app` charges deploy credits.

Non-Apple targets always build locally. Apple targets build locally on a Mac; on
another host they need the remote Apple builder, and declining that prompt skips
them.

## Step 2: complete the deploy draft

On the app's Deploy page at `app.pekoui.com/apps/<appId>/deploy`, the wizard runs
through seven steps:

1. Review bundle: confirms uploaded platforms, sizes, hashes.
2. Version: set the release version.
3. Targets and stores: pick which stores and platforms to target.
4. Generate assets: the device farm produces screenshots and recordings. Charges
   deploy credits.
5. Legal: privacy and terms URLs, with AI-assisted drafting to approve.
6. Descriptions: per-store listing text, AI drafted, to approve.
7. Review and submit, ending in "Finish draft".

The wizard advances client-side and missing fields are flagged rather than
blocked, so a user can reach the end with an incomplete bundle.

**"Finish draft" is one-way and destructive.** It packs the final zip, flips the
release to `bundled`, and deletes the working sources: screenshots, listing text,
and unpacked binaries. Only the zip survives. Tell users to finish only once they
are happy with the content.

Peko-side statuses run `uploading -> unpacking -> building -> draft -> bundled`
and end at the downloadable bundle. Anything past `bundled` is the user's own
submission, tracked in the store consoles rather than on Peko.

## Step 3: download the bundle

The app's Distribution tab lists finished deploys with a Download bundle button
that issues a fresh short-lived URL. The file is
`<AppName>-<version>-stores.zip`, organized per store:

```
<AppName>-<version>-stores.zip
  manifest.json        app name, bundle id, version, targeted stores
  README.md            the authoritative per-store walkthrough
  apple/
    manifest.json      every App Store Connect field with its character limit
    listing.txt        the same fields for copy and paste
    legal.txt          privacy and terms URLs
    media/screenshots/, media/recordings/
    bundle/ios/ (.ipa), bundle/macos/ (.pkg)
  google/
    manifest.json, listing.txt, legal.txt, media/, bundle/android/ (.aab)
  microsoft/
    manifest.json, listing.txt, legal.txt, media/, bundle/windows/ (.msix)
```

`listing.txt` flags fields that are still unwritten or over the character limit.

Which binary goes to which store:

| Store | Upload | Not this |
|---|---|---|
| Apple iOS | `.ipa` | the `.app` |
| Apple macOS | `.pkg` | the `.app` |
| Google Play | `.aab` | an `.apk` |
| Microsoft | `.msix` | anything signed by you |
| Linux | no store target | assets only |

## Step 4: submit, which the user does

The zip's `README.md` is authoritative. The summary:

**Apple, in App Store Connect.** Register the Bundle ID and create the app record.
Upload `apple/bundle/ios/*.ipa`, and the `.pkg` for macOS, using Transporter or
Xcode's Organizer. Copy the fields from `apple/listing.txt` into the matching
fields. Then complete the browser-only items that cannot be imported: Age Rating,
App Privacy, Pricing, and Export compliance. App Privacy blocks submission until
it is done. Add for Review, then Submit.

**Google, in Play Console.** Create the app. Upload `google/bundle/android/*.aab`;
the first upload has to be done in the browser. Accept Play App Signing and keep
the upload key. Complete the browser-only App content section: Data safety,
Content rating, Target audience, Ads declaration, Privacy policy URL, and App
access. Copy `google/listing.txt` into the store listing, then start rollout.

**Microsoft, in Partner Center.** Reserve the app name, which is browser-only.
Upload `microsoft/bundle/windows/*.msix`. Complete the IARC age rating,
Properties, and Pricing. Copy `microsoft/listing.txt`, then submit.

Always tell the user to review every generated screenshot and every drafted
listing field before submitting. The drafts are AI-assisted starting points, and
each store rejects incomplete or non-compliant metadata.

## Verifying the automation before a real run

`peko demo` builds in demo mode, launches against the framework dev server, and
drives the declared shots through the in-page automation agent, printing each
step. It produces no screenshots; it confirms the shot scripts navigate, find
elements, and interact as written.

The app declares fixtures and shots under `[demo]` in `peko.toml`, depends on
`pekoshots`, and calls `pekoshots::driver::attach` from its entry. Shot scripts
are event-gated: wait for a condition rather than sleeping, and use a fixed delay
only for presentation pacing.

```
peko demo                       # every declared shot
peko demo onboarding            # one shot
peko demo dark-settings --from 2
```
