# Third-party software

GainMate source is MIT licensed. The distributed application includes independent FFmpeg and LAME executables/libraries with their own obligations. MIT does not override these licenses.

- FFmpeg 7.1.2: LGPL 2.1 or later, built without GPL, version3, nonfree, network support, or externally detected libraries. https://ffmpeg.org/legal.html
- LAME 3.100: LGPL 2.0 or later. Statically incorporated into the separate FFmpeg executable. https://lame.sourceforge.io/license.txt
- zlib: zlib license (PNG artwork support). macOS links system zlib; Windows uses the MSYS2 static library.
- Inter and IBM Plex Mono fonts: SIL Open Font License 1.1; bundled locally, no font network requests.
- Rust ebur128: MIT. https://github.com/sdroege/ebur128
- MPL 2.0: `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext` and `selectors` in the resolved Rust graph. Matching unmodified crate sources and licenses are included in each source archive. MPL imposes file-level source obligations; it does not relicense GainMate's original MIT files.
- Tauri: MIT or Apache 2.0. React: MIT. Lucide: ISC. SQLite: public domain.

The source distributions, exact configure/build script, checksums, generated configuration and license texts accompany release downloads in the audio-source archive. The audio executables can be independently rebuilt and replaced; they communicate with the MIT application over standard streams and are not linked into it. Keep these notices and the matching source available with every redistributed binary. No GPL Homebrew or third-party FFmpeg binary may be substituted into a release without reviewing its additional obligations.

`Cargo.lock` and `package-lock.json` record exact dependencies. The release workflow also generates dependency license inventories. This is an engineering license inventory, not a claim that every distribution jurisdiction has identical codec/patent requirements.
