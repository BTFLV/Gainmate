# Builds and rolling releases

## What runs

`Quality` runs on PRs and pushes to `main`: TypeScript, ESLint, Prettier, Vitest, browser smoke tests, production frontend build, Rust formatting, Clippy and Rust integration tests. Audio tests run against the exact bundled FFmpeg build, not a runner's system installation.

`Release` runs on pushes to `main` or manual dispatch. It first calls the same quality workflow, then builds and runs audio tests on:

| Runner           | Rust target              | Installer             |
| ---------------- | ------------------------ | --------------------- |
| `macos-15`       | `aarch64-apple-darwin`   | DMG for Apple Silicon |
| `macos-15-intel` | `x86_64-apple-darwin`    | DMG for Intel         |
| `windows-2025`   | `x86_64-pc-windows-msvc` | NSIS EXE installer    |

Windows audio tools are compiled with MinGW inside MSYS2 and statically link their non-system dependencies. The application is compiled with MSVC. These are separate processes, so the differing C runtime/toolchain is intentional.

Only the final publication job receives `contents: write`. It uses the automatic `GITHUB_TOKEN`. PR jobs cannot publish releases. No PAT is required.

## Rolling release consistency

The normal, non-draft, non-prerelease release is named **Latest GainMate Release**, at the mutable tag **latest**, with `make_latest: true`. The app's semantic version comes from `src-tauri/tauri.conf.json`, `package.json` and workspace `Cargo.toml`; change all three together. The mutable tag is not an app version.

All build jobs must succeed before publication. Each workflow run uploads uniquely named installer and matching source/license archives. Publication checks that all three installers and all three source archives exist. It uploads the whole artifact set into a new draft release before touching the public release. Then it temporarily archives the old release as a draft, moves `latest` to the built commit and publishes the complete new release. The old assets are deleted only after promotion succeeds. A handled promotion failure restores the previous release and tag.

GitHub has no transaction spanning release and Git-ref updates. There can be a short availability gap during promotion; there is no intentional state with a mixed old/new public artifact set. An abruptly terminated runner/API outage during promotion may require an administrator to republish the retained previous draft. Drafts named `gainmate-previous-*` retain the old assets until successful promotion. Do not delete recovery drafts before checking the normal latest release.

Release runs use a single concurrency group with `cancel-in-progress: false`. Older builds also check the current `main` head before publishing, so they cannot replace a newer commit. Repository rules that prohibit updating the `latest` tag must exempt this automation.

## Apple signing and notarization

No secrets are needed for local or CI ad-hoc signing. The default signing identity is `-`; notarization is skipped when credentials are absent. This is not Apple Developer signing and does not bypass Gatekeeper.

To enable Developer ID signing, configure these repository Actions secrets:

| Secret                       | Exact value                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of an exported **Developer ID Application** `.p12` certificate and private key. Use `openssl base64 -A -in certificate.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12`.                                                                                           |
| `APPLE_SIGNING_IDENTITY`     | Full Keychain identity, e.g. `Developer ID Application: Your Name (TEAMID)`.                                                        |

To also enable notarization, add all three:

| Secret           | Exact value                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `APPLE_ID`       | Apple Developer account email.                                        |
| `APPLE_PASSWORD` | An Apple **app-specific password**, not your normal account password. |
| `APPLE_TEAM_ID`  | Ten-character Apple Developer team ID.                                |

The workflow enables signing only when the three signing secrets exist and notarization only when its three secrets also exist. Tauri imports the certificate and performs signing/notarization. No long-lived custom keychain password is required by this workflow. Partial secret groups fall back to ad-hoc signing or signing without notarization; verify the build log when setting them up.

Tauri also supports App Store Connect API authentication (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`). This workflow implements the Apple ID route; to switch, securely create the `.p8` file on the runner and provide those three variables instead. See [Tauri's macOS signing documentation](https://v2.tauri.app/distribute/sign/macos/).

Windows code signing is not configured. SmartScreen can warn on unsigned installers. Add an appropriate signing service later; an Apple certificate does not sign Windows software.

## Repository settings

1. Enable Actions and allow the actions referenced by these workflows, including MSYS2 and the Rust toolchain/cache actions.
2. Allow workflow `GITHUB_TOKEN` write permissions for releases; the YAML limits this to the publication job. Organization policy may override repository settings.
3. If using branch protection, make Quality a required check. Do not require signing or protection on mutable `latest` without an automation exception.
4. Ensure private-repository Actions minutes/artifact storage are sufficient. Downloads remain private until the repository becomes public.
5. Push the implementation to `main` when you intend to publish. Local development does not create remote releases.

## Dependency distribution

Every installer has a matching `_sources-and-notices.tar.gz` archive with checksum-verified FFmpeg/LAME source tarballs, the exact build script/configuration, and Rust/npm license inventories and license/notice files. Keep these assets together. FFmpeg must remain LGPL-only under this build configuration. Do not replace it with a Homebrew GPL build for publication.

The pinned audio source versions and SHA-256 values live in `scripts/build-audio.sh`. Update source versions, artifact packaging filenames, the documented inventory and the cache key input together, then run the full audio suite. Updating only the binary is not a reproducible release.
