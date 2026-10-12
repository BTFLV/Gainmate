# Audio processing and safety

## Measurement

FFmpeg decodes one audio stream into interleaved float32 PCM at its original sample rate and channel layout. Rust `ebur128` measures BS.1770 / EBU R128 integrated loudness, 400 ms momentary loudness, 3 s short-term loudness, loudness range, sample peak and interpolated true peak. The meter's histogram mode bounds its loudness history. Mono, stereo, 2.1, 3.0, 4.0, quad, 5.0, 5.1 and 7.1 have explicit channel weighting; LFE is excluded from loudness but included in peak scanning. Unknown layouts are rejected rather than downmixed.

Waveform envelopes are amplitude maxima, not loudness. They are calculated in the same decoded pass, at approximately 1,200 bins. The separate loudness timeline stores up to about 1,800 time-aligned points. A track detail request loads the full timeline; the collection receives only a compact waveform. Two analysis workers limit disk contention. Normalization is serial, reducing memory pressure and simultaneous output I/O. Subprocess cancellation checks run every 30 ms; completed files remain valid when a later item is cancelled.

Integrated loudness is null for silence or audio too short to measure. It is never replaced by a fabricated value. Support is limited to 8–384 kHz and at most eight channels, with a maximum declared duration of 24 hours. Some channel/rate/codec combinations can be decoded but not re-encoded into the source container; those fail safely at export.

## Processing

The default is Precise Normalize, −12 LUFS, −1 dBTP. Targets range from −36 to −6 LUFS; ceilings from −9 to 0 dBTP. The ceiling is always enabled in this release.

- **Precise Normalize:** apply a constant high-precision gain when it fits below the ceiling. Otherwise use FFmpeg `loudnorm` in dynamic mode, which performs oversampled peak management. Resample back to the original rate. This can alter dynamics as well as peaks; it is not described as a purely transparent gain adjustment. Refuse more than 6 dB of predicted peak reduction. Independently decode and measure each encoded output, allowing up to four controlled attempts. Commit only within **±0.3 LU** of target and at or below the ceiling.
- **Safe Gain:** one uniform gain, capped by source true peak. No limiter or compressor. An encoded peak overshoot can trigger a lower uniform gain on a fresh encode of the original. The final loudness may be below target and is reported as such.

Initial peak margins are 0.08 dB for lossless containers and 0.4 dB for MP3; verification governs acceptance. Subsequent attempts always read the original, never a prior MP3 encode. Metadata ReplayGain/R128 gain fields are removed because their previous values become invalid.

This is not a subjective transparency certification. Aggressive targets can sound worse. The synthetic fixture/reference checks establish numerical behavior for tested material; audition important material and keep backups. Full EBU conformance-vector certification and a large listening corpus remain future work.

## Formats and metadata

MP3 is encoded with LAME V0 VBR. It is a lossy generation even when only gain changes. MP3Gain-style frame scaling offers roughly 1.5 dB steps and cannot implement arbitrary LUFS targets or true-peak limiting. A frame-editing path is not implemented; no lossless-MP3 claim is made. Source MP3 bitrate/CBR versus VBR is not retained.

FLAC stays FLAC with lossless encoding and source bit depth. PCM WAV retains supported original sample representation (8-bit unsigned, 16/24/32-bit signed, 32/64-bit float) and uses RF64 when needed. Dither is requested in the uniform-gain conversion path. Processing changes sample values even in a lossless container.

Title, artist and album are explicitly verified. MP3/FLAC attached artwork is copied and checked. Other tags are copied by FFmpeg on a best-effort basis; encoder-specific/private frames and metadata may be transformed or lost. Unknown WAV RIFF chunks, cues, embedded artwork, filesystem extended attributes, creation dates and ACLs are not guaranteed to survive. WAV warnings are shown before processing. Unix permission bits are retained on output. Rekordbox XML playlists are imported for selection; no internal Rekordbox/device database is ever edited. Reanalyze replaced files in Rekordbox when appropriate.

## File integrity

Outputs are encoded into randomly named, same-directory temporary files. Full decode, exact sample-frame count, rate/layout, key metadata, loudness and peak checks precede commit. Export uses no-clobber persistence; a file that appears after review will not be overwritten. Source content hashes are checked before replacement. Optional backups are byte copies, synced and hash-verified. A durable SQLite prepared operation records source/output/backup hashes before commit; completed history is recorded after commit. A crash between these steps can leave a prepared record. Verify the hashes before interpreting it as completed; restore checks them automatically.

Replacement uses the `tempfile` platform implementation for atomic rename/replacement on a local filesystem. No software can promise atomicity or power-loss durability for every network share, unusual removable filesystem, disk controller or concurrent external writer. Analysis never opens original files for writing. Restore refuses modified outputs or damaged/modified backups. Backups are retained after restore.

Cache keys use canonical path, byte length, nanosecond modification time and an internal analysis schema version. An external program that changes bytes while deliberately preserving size and timestamp can defeat this cache. Remove the cache database and reanalyze in that unusual case. Before processing, file hashes independently protect the source against normal concurrent changes.

The data directory is resolved by Tauri (`app.gainmate.desktop`); macOS normally stores it under `~/Library/Application Support/app.gainmate.desktop`. The SQLite file contains local paths, measurements, session and operation records. No telemetry is sent.
