# Local validation

Validated on 2026-10-12 on macOS Apple Silicon, with Rust 1.99, Node.js 26.5 and the application's own LGPL FFmpeg 7.1.2 / LAME 3.100 sidecars. These are observed local results, not claims that the GitHub workflows have run.

## Automated checks

| Check                                             | Result                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TypeScript and ESLint (`npm run check`)           | Passed                                                                                       |
| Prettier (`npm run format:check`)                 | Passed                                                                                       |
| Vitest                                            | 9 passed: loudness predictions/distribution and rolling-release publication/rollback         |
| Playwright                                        | 3 passed: navigation/settings, minimum window size, and a 5,000-track virtualized collection |
| Rust formatting and Clippy, all workspace targets | Passed with warnings denied                                                                  |
| Rust integration tests, bundled audio tools       | 18 passed                                                                                    |
| Production frontend                               | Built successfully                                                                           |
| GitHub workflow syntax (`actionlint`)             | Passed                                                                                       |
| Audio build script (`shellcheck`)                 | Passed                                                                                       |

The 18 Rust tests cover reference loudness agreement, intersample peaks, uniform Safe Gain, verified Precise Normalize with limiting, MP3/WAV/FLAC round trips, title/artist/album and artwork retention, exact decoded timing, 44.1/48/96/192 kHz, mono/stereo/surround, byte-exact backup/restore, changed-file refusal, cancellation before and during decoding, no-clobber export, collision and stale-source detection, recursive imports, cache/session persistence, concurrent database initialization, encoded Unicode Rekordbox paths/playlists/missing files, silence and very short audio.

The large-collection browser test uses explicitly synthetic measurements to isolate renderer behavior. With 5,000 tracks, fewer than 40 rows are mounted; artist/filename sorting, scrolling to the end, searching and target changes work at 1000 × 680. This is a bounded-rendering regression test, not a benchmark of decoding 5,000 real tracks.

## Real audio through the UI

`scripts/generate-fixtures.py` creates 12 original CC0 audio files across WAV, FLAC and MP3. `scripts/capture-ui.mjs` drives the actual React application and a compiled Rust command adapter:

1. Import and analyze all 12 files.
2. Display their measured library, waveform and short-term loudness.
3. Review the real export plan and acknowledge its paths/mode.
4. Normalize to −12 LUFS with a −1 dBTP ceiling.
5. Read completed operation history and assert verified target and ceiling compliance for every output.

All 12 completed, with no UI alerts or JavaScript errors. Maximum absolute target error was **0.248 LU**; the highest measured output true peak was **−1.008 dBTP**. These files all exercised necessary peak management. Measurements come from decoded output, not predicted values. The separate Rust suite covers uniform gain and intentionally unreachable Safe Gain targets.

The screenshots under `docs/screenshots/` come from that real renderer/engine run. A developer-only adapter supplies native dialog selections and transports IPC to the Rust executable. Native macOS screen capture was unavailable. Consequently the screenshots and browser tests do not certify native dialogs, OS drag-and-drop or WebKit preview playback. They are not fictional designs or fabricated audio results.

To repeat the integrated capture, start `npm run dev`, generate the fixtures with Python 3 and a system FFmpeg, build `cargo build --release -p gainmate-core --example command`, and run `node scripts/capture-ui.mjs`. The script currently targets the local Apple Silicon sidecar names. It writes output into a temporary directory and its report to ignored `.audio-build/ui-validation.json`.

## Desktop package

`npm run package -- --bundles app,dmg` produced a real Apple Silicon application and DMG in `target/release/bundle`. The packaged application launched on this Mac and exposed a native GainMate window. Both bundled audio tools execute from inside the app. App/dependency signatures pass `codesign --verify --deep --strict`; the installer passes `hdiutil verify`.

The package is ad-hoc signed, without Developer ID notarization. Its audio sidecars depend on system libraries, with no Homebrew or developer-machine library paths. The local release-artifact script also packages the installer, corresponding audio/MPL sources, dependency notices and SHA-256 checksums without publishing a release.

## Limits of the evidence

- Windows x64 builds/tests are configured in CI but were not executed locally. macOS releases target Apple Silicon (arm64) only. Their first successful CI run and native smoke checks remain necessary before claiming platform validation.
- GitHub publication was tested against an isolated mocked API, including upload failure, rollback and stale-build protection. No remote release was created as a test.
- No Apple Developer credentials were available; Developer ID signing and notarization are prepared but untested.
- The checks are not full EBU conformance certification or a broad subjective listening study. Aggressive loudness targets can audibly change dynamics. MP3 always incurs a lossy re-encode in this version.
- System-specific preview codec support, arbitrary proprietary metadata, unusual filesystems, abrupt power loss and simultaneous external writers are not exhaustively covered. See [audio behavior](AUDIO.md).
