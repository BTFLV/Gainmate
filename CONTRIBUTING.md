# Contributing

Use Node 24+, stable Rust, and platform prerequisites from the README. Build the pinned audio sidecars before running the desktop application. Keep the audio core independent of Tauri.

Before opening a PR:

```sh
npm ci
npm run audio:build
npm run check
npm run format:check
npm test
npm run test:ui
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=2
```

Set `GAINMATE_FFMPEG` and `GAINMATE_FFPROBE` to the absolute paths of the bundled binaries when validating release behavior. `cargo test` otherwise uses tools on PATH. CI always tests the bundled build.

Write audio tests that check measurements, samples, metadata or file integrity, not merely successful process exit. Use generated CC0 fixtures; do not contribute copyrighted music. The tiny yellow test cover and the synthesized material from `scripts/generate-fixtures.py` are original CC0 test assets.

Never commit `target`, `dist`, `.audio-build`, generated music, local SQLite data, certificates or secrets. Installer/source archives are release assets, not repository files. Screenshots must depict the actual UI and identify generated test material.

The local developer adapter (`gainmate-core/examples/command.rs`) exists only for browser integration tests with the real engine. It is not compiled into or exposed by the production application. `scripts/capture-ui.mjs` adapts native dialog/IPC transport to this executable; measurements and output files remain real.

Keep the interface functional and concise: neutral black/gray/white surfaces, bright yellow only for accents, compact square controls. Avoid promotional copy in tool panels.
