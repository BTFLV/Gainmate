#!/usr/bin/env bash
# Reproducible, minimal LGPL FFmpeg sidecars. No GPL/nonfree codecs or network protocols.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
TARGET="${GAINMATE_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
BUILD="$ROOT/.audio-build/$TARGET"
DOWNLOADS="$ROOT/.audio-build/downloads"
PREFIX="$BUILD/prefix"
mkdir -p "$BUILD" "$DOWNLOADS" "$ROOT/src-tauri/binaries" "$ROOT/src-tauri/resources/audio"
fetch() {
  if [ ! -f "$DOWNLOADS/$1" ]; then curl --fail --location --retry 3 "$2" -o "$DOWNLOADS/$1"; fi
  printf '%s  %s\n' "$3" "$DOWNLOADS/$1" | shasum -a 256 -c -
}
fetch ffmpeg-7.1.2.tar.xz https://ffmpeg.org/releases/ffmpeg-7.1.2.tar.xz 089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304
fetch lame-3.100.tar.gz https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
JOBS="${GAINMATE_BUILD_JOBS:-4}"
EXT=""; EXTRA=(); LAME_EXTRA=()
case "$TARGET" in
  *apple-darwin) export MACOSX_DEPLOYMENT_TARGET=11.0 ;;
  *windows*) EXT=".exe"; EXTRA+=(--target-os=mingw32 --arch=x86_64 --extra-ldflags=-static); LAME_EXTRA+=(--host=x86_64-w64-mingw32) ;;
esac
if [ ! -f "$PREFIX/lib/libmp3lame.a" ]; then
  tar -xzf "$DOWNLOADS/lame-3.100.tar.gz" -C "$BUILD"
  (cd "$BUILD/lame-3.100" && ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-frontend --disable-gtktest "${LAME_EXTRA[@]}" && make -j"$JOBS" && make install)
fi
SCRIPT_HASH="$(shasum -a 256 "$ROOT/scripts/build-audio.sh" | cut -d' ' -f1)"
if [ ! -f "$BUILD/ffmpeg-7.1.2/ffmpeg$EXT" ] || [ "$(cat "$BUILD/config-hash" 2>/dev/null || true)" != "$SCRIPT_HASH" ]; then
  tar -xf "$DOWNLOADS/ffmpeg-7.1.2.tar.xz" -C "$BUILD"
  (cd "$BUILD/ffmpeg-7.1.2" && ./configure --prefix="$PREFIX" --disable-gpl --disable-nonfree --disable-version3 --disable-autodetect --disable-network --disable-doc --disable-debug --disable-shared --enable-static --disable-ffplay --disable-avdevice --disable-postproc --disable-swscale --disable-everything --disable-x86asm --enable-ffmpeg --enable-ffprobe --enable-libmp3lame --enable-zlib --enable-protocol=file,pipe --enable-demuxer=mp3,wav,flac,image2,png_pipe --enable-muxer=mp3,wav,flac,pcm_f32le,null,image2pipe --enable-decoder=mp3,mp3float,mp3adu,mp3adufloat,mp3on4,mp3on4float,flac,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be,pcm_alaw,pcm_mulaw,png,mjpeg --enable-encoder=libmp3lame,flac,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le --enable-parser=mpegaudio,flac,png,mjpeg --enable-filter=aresample,aformat,anull,volume,loudnorm,ebur128,asplit,ashowinfo --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" "${EXTRA[@]}" && make -j"$JOBS")
  printf '%s\n' "$SCRIPT_HASH" > "$BUILD/config-hash"
fi
for tool in ffmpeg ffprobe; do
  cp "$BUILD/ffmpeg-7.1.2/$tool$EXT" "$ROOT/src-tauri/binaries/$tool-$TARGET$EXT.new"
  chmod +x "$ROOT/src-tauri/binaries/$tool-$TARGET$EXT.new"
  if [[ "$TARGET" == *apple-darwin ]]; then codesign --force --sign - "$ROOT/src-tauri/binaries/$tool-$TARGET$EXT.new"; fi
  mv -f "$ROOT/src-tauri/binaries/$tool-$TARGET$EXT.new" "$ROOT/src-tauri/binaries/$tool-$TARGET$EXT"
done
cp "$BUILD/ffmpeg-7.1.2/COPYING.LGPLv2.1" "$ROOT/src-tauri/resources/audio/FFmpeg-LICENSE.txt"
cp "$BUILD/lame-3.100/COPYING" "$ROOT/src-tauri/resources/audio/LAME-LICENSE.txt"
cp "$BUILD/ffmpeg-7.1.2/ffbuild/config.mak" "$ROOT/src-tauri/resources/audio/ffmpeg-build-config.txt"
cp "$ROOT/LICENSE" "$ROOT/src-tauri/resources/audio/GainMate-LICENSE.txt"
if [ -d "$ROOT/node_modules/@fontsource-variable/inter" ]; then
  cp "$ROOT/node_modules/@fontsource-variable/inter/LICENSE" "$ROOT/src-tauri/resources/audio/Inter-LICENSE.txt"
  cp "$ROOT/node_modules/@fontsource/ibm-plex-mono/LICENSE" "$ROOT/src-tauri/resources/audio/IBM-Plex-Mono-LICENSE.txt"
fi
cp "$ROOT/assets/ZLIB-LICENSE.txt" "$ROOT/src-tauri/resources/audio/ZLIB-LICENSE.txt"
cp "$ROOT/THIRD_PARTY.md" "$ROOT/src-tauri/resources/audio/THIRD_PARTY.md"
"$ROOT/src-tauri/binaries/ffmpeg-$TARGET$EXT" -version
"$ROOT/src-tauri/binaries/ffmpeg-$TARGET$EXT" -L
