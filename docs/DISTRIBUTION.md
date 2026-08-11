# Distribution: signing, notarizing and releasing Worktree Manager

This is the operator's guide for shipping a macOS build your teammates can
double-click without seeing "Apple could not verify…". It assumes you have a
paid Apple Developer account and have never notarized an app before.

There are three tiers of build:

| Tier | Command | Signed? | Notarized? | Who for |
|------|---------|---------|-----------|---------|
| Local dev install | `./scripts/install-local.sh` | ad-hoc | no | you only |
| Local release | `./scripts/release-build.sh` | Developer ID | yes | you, or a hand-delivered .dmg |
| CI release | push a `v*` tag | Developer ID | yes | the team, via GitHub releases |

Two vocabulary notes before you start:

- **Signing** stamps the app with your Developer ID certificate so macOS can
  tell who built it and that it has not been modified.
- **Notarization** uploads the signed app to Apple, which scans it for malware
  and returns a ticket. `stapler` attaches that ticket to the .dmg so Gatekeeper
  can verify it offline. Without notarization a signed app still gets blocked on
  first launch.

---

## 1. One-time Apple setup

You need three things: a **Developer ID Application** certificate, your **Team
ID**, and an **app-specific password**.

### 1a. Developer ID Application certificate

Right now you have zero codesigning identities in your keychain — confirm with:

```bash
security find-identity -v -p codesigning
```

If that prints `0 valid identities found`, you need to create one. Normally
Xcode does this for you, but you only have the Command Line Tools, so use the
helper script, which drives `openssl`/`security` directly:

```bash
# 1. Generate a private key + certificate signing request (CSR).
./scripts/signing-setup.sh

# It writes signing/developer-id.key and signing/developer-id.csr
# (the whole signing/ directory is gitignored).

# 2. Upload the generated CSR at:
#    https://developer.apple.com/account/resources/certificates/add
#    Choose certificate type: "Developer ID Application"
#    (NOT "Apple Development", NOT "Developer ID Installer")
#    Download the resulting developer_id_application.cer and MOVE IT INTO
#    the signing/ directory — --import looks for a *.cer file there.
mv ~/Downloads/developer_id_application.cer signing/

# 3. Package the key + cert as a .p12 and import it into the login keychain.
#    You will be prompted for an export password; remember it, you need it
#    again for CI (it becomes APPLE_CERTIFICATE_PASSWORD).
./scripts/signing-setup.sh --import

# 4. Confirm it worked — this should now list your identity.
./scripts/signing-setup.sh --check
```

The identity string it prints is exactly what goes into
`APPLE_SIGNING_IDENTITY`, including the team ID in parentheses:

```
Developer ID Application: Your Name (ABCDE12345)
```

Keep the generated private key. If you lose it, the certificate is useless and
you have to revoke and reissue.

### 1b. Team ID

Go to <https://developer.apple.com/account>, open **Membership details**, and
copy the 10-character **Team ID**. It is the same string that appears in
parentheses in your signing identity.

### 1c. App-specific password

Notarization authenticates as your Apple ID, but **you must not use your Apple
account password** — Apple rejects it, and it would give a CI runner full
control of your Apple ID. Create a scoped password instead:

1. Sign in at <https://appleid.apple.com>.
2. **Sign-In and Security** → **App-Specific Passwords** → **+**.
3. Name it something like `worktree-manager-notarization`.
4. Copy the `xxxx-xxxx-xxxx-xxxx` value — it is shown once.

That value is `APPLE_PASSWORD`. You can revoke it at any time from the same
page without touching your account password.

---

## 2. Local release builds

```bash
cp .env.signing.example .env.signing
$EDITOR .env.signing     # fill in the four values from step 1
./scripts/release-build.sh
```

For a fast signing-only check that skips Apple's notarization queue:

```bash
./scripts/release-build.sh --skip-notarize
```

(Do not hand that build to anyone — signed-but-not-notarized is exactly the
case Gatekeeper blocks.)

`release-build.sh` sources `.env.signing`, runs
`pnpm tauri build --target universal-apple-darwin --bundles app,dmg`, then
verifies the result with `codesign`, `spctl`, `stapler` and `lipo`.

Artifacts land in:

```
src-tauri/target/universal-apple-darwin/release/bundle/macos/   # .app
src-tauri/target/universal-apple-darwin/release/bundle/dmg/     # .dmg
```

Note the `universal-apple-darwin` path segment — a plain `pnpm tauri build`
writes to `src-tauri/target/release/bundle/` instead, so don't copy paths
between the two.

`.env.signing` is gitignored (along with `*.p12` and `signing/`). **Never commit
it.** If you ever do, revoke the app-specific password and reissue the
certificate immediately.

You can spot-check any build yourself:

```bash
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Worktree Manager.app"
codesign -dv --verbose=4 "$APP"          # identity + hardened runtime
spctl -a -vvv -t exec "$APP"             # Gatekeeper verdict
xcrun stapler validate "$APP"            # notarization ticket present
lipo -archs "$APP/Contents/MacOS/Worktree Manager"   # -> x86_64 arm64
```

---

## 3. CI releases (GitHub Actions)

`.github/workflows/release.yml` runs on `macos-14`, builds the universal
bundle, signs and notarizes it, and creates a **draft** GitHub release.

CI has no keychain, so it needs the certificate itself as a base64 secret.

### 3a. Get the certificate as a base64 .p12

If you set the certificate up with `./scripts/signing-setup.sh --import`, the
.p12 already exists at `signing/developer-id.p12` and its export password is
the one you typed then — skip straight to the base64 step below.

Otherwise, export it from Keychain Access:

1. Open **Keychain Access** → **login** keychain → **My Certificates**.
2. Find `Developer ID Application: Your Name (TEAMID)`.
3. Right-click → **Export…** → format **Personal Information Exchange (.p12)**.
4. Set a strong export password. That password becomes
   `APPLE_CERTIFICATE_PASSWORD`.
5. Save it somewhere temporary, e.g. `~/Desktop/cert.p12`.

Base64-encode it and put it on your clipboard:

```bash
# from signing-setup.sh
base64 -i signing/developer-id.p12 | pbcopy

# or from a Keychain Access export
base64 -i ~/Desktop/cert.p12 | pbcopy
```

> **The .p12 and its password are the crown jewels.** Together they let anyone
> sign software as you — malware signed with your identity would be trusted by
> every Mac until Apple revokes the certificate. Store them in a password
> manager, never in Slack or email, and delete any copy you exported outside
> the gitignored `signing/` directory when you are done:
>
> ```bash
> rm ~/Desktop/cert.p12
> ```

### 3b. The six required repository secrets

| Secret | What it is |
|--------|-----------|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you chose when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (ABCDE12345)` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_PASSWORD` | app-specific password from step 1c (**not** your account password) |
| `APPLE_TEAM_ID` | 10-character Team ID from step 1b |

`GITHUB_TOKEN` is provided automatically by Actions — do not create it.

Set them with the `gh` CLI (each prompts for the value on stdin, so nothing
lands in your shell history):

```bash
REPO=Maxymvs/worktree-manager

base64 -i signing/developer-id.p12 | gh secret set APPLE_CERTIFICATE -R "$REPO"
gh secret set APPLE_CERTIFICATE_PASSWORD -R "$REPO"
gh secret set APPLE_SIGNING_IDENTITY -R "$REPO"
gh secret set APPLE_ID -R "$REPO"
gh secret set APPLE_PASSWORD -R "$REPO"
gh secret set APPLE_TEAM_ID -R "$REPO"

gh secret list -R "$REPO"   # verify all six are present
```

The workflow only requests `permissions: contents: write`, which is what it
needs to create the release and upload assets.

---

## 4. The release flow, end to end

```bash
# 1. Bump the version in package.json, tauri.conf.json and Cargo.toml,
#    and commit. (Slash command in Claude Code; the script is
#    .claude/skills/bump/bump.sh.)
/bump 0.8.0

# 2. Push the commit and the tag. The tag is what triggers the workflow.
git push origin main
git tag v0.8.0
git push origin v0.8.0

# 3. Watch the build (~20-40 min including Apple's notarization queue).
gh run watch -R Maxymvs/worktree-manager

# 4. Review the draft release: check the version, the release notes, and
#    that a universal .dmg is attached.
gh release view v0.8.0 -R Maxymvs/worktree-manager --web

# 5. Publish it.
gh release edit v0.8.0 -R Maxymvs/worktree-manager --draft=false
```

You can also re-run a build for an existing tag from the Actions tab via
**Run workflow** and entering the tag in the optional `tag` input.

---

## 5. What teammates do

1. Open the release page and download `Worktree Manager_<version>_universal.dmg`.
2. Double-click the .dmg, drag **Worktree Manager** to **Applications**.
3. Eject the .dmg and open the app normally — double-click, or Spotlight.

That's it. Specifically:

- **No `xattr -cr` / right-click-Open workaround is needed.** Those hacks exist
  to bypass Gatekeeper for *unsigned* builds. A notarized, stapled .dmg passes
  Gatekeeper on the first try; if someone tells you to run `xattr`, something
  went wrong with notarization instead.
- **One .dmg for every Mac.** The build is universal, so the same file runs
  natively on Intel and Apple Silicon — no separate downloads, no Rosetta.

---

## 6. Troubleshooting

**"The binary is not signed with a valid Developer ID certificate."**
The app was signed with something other than a Developer ID Application
certificate — usually an ad-hoc signature (`-`) from `install-local.sh`, an
"Apple Development" certificate, or an empty/typo'd `APPLE_SIGNING_IDENTITY` so
Tauri skipped signing. Check `security find-identity -v -p codesigning`
locally, or that the `APPLE_SIGNING_IDENTITY` secret matches the certificate in
the `APPLE_CERTIFICATE` .p12 exactly, character for character.

**Notarization rejected.** Apple returns a submission ID; the log explains what
it disliked (unsigned nested binary, missing hardened runtime, and so on):

```bash
xcrun notarytool log <submission-id> \
  --apple-id "you@example.com" \
  --team-id "ABCDE12345" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

To list recent submissions when you don't have the ID handy:

```bash
xcrun notarytool history \
  --apple-id "you@example.com" --team-id "ABCDE12345" --password "xxxx-xxxx-xxxx-xxxx"
```

**The build seems to hang after signing.** Notarization normally takes **5-15
minutes** and can occasionally be much slower when Apple's queue is backed up.
The workflow's 60-minute timeout is generous on purpose. Check
<https://developer.apple.com/system-status/> before assuming it is your fault.

**The first launch of a newly-signed build asks for keychain access again.**
Expected, not a bug. The app stores GitHub/Jira tokens in the login keychain
under the service name `grovr`, and macOS scopes keychain ACLs to a specific
code signature. A new signing identity means a different signature, so macOS
asks for permission again. Click **Always Allow** (you may be asked once per
stored token). The tokens themselves are intact — nothing needs to be
re-entered.

**Notarization fails with "Unable to notarize — invalid credentials".**
Almost always the Apple account password was used instead of an app-specific
password, or the app-specific password was revoked. Regenerate it (step 1c) and
update `.env.signing` / the `APPLE_PASSWORD` secret.

---

## 7. Updates

There is **no auto-updater**. The Tauri updater was removed because it pointed
at the upstream author's signed releases, and it was not replaced. Updating
means downloading the new .dmg from the releases page and dragging it over the
copy in `/Applications`. Tell teammates when you publish a release; settings and
stored tokens survive the replacement because the bundle identifier
(`com.grovr.desktop`) and keychain service name (`grovr`) stay the same.
