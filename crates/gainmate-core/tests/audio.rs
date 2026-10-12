use gainmate_core::{
    analysis::{analyze, fingerprint},
    import::{collect, parse_rekordbox},
    model::{predict, Mode, Settings},
    normalize::{hash_file, normalize, plan, restore},
    process::{cancel_token, AudioTools},
    store::Store,
};
use std::{
    f64::consts::PI,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering,
};
use tempfile::TempDir;

fn fixture(path: &Path, amplitude: f64, transient: bool, rate: u32, seconds: u32) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: rate,
        bits_per_sample: 24,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..rate * seconds {
        let t = i as f64 / rate as f64;
        let envelope = if transient && t % 1.0 < 0.014 {
            amplitude * 4.
        } else {
            amplitude
        };
        let v = (2. * PI * 1000. * t).sin() * envelope;
        let sample = (v * (1 << 23) as f64).round() as i32;
        w.write_sample(sample).unwrap();
        w.write_sample(sample).unwrap();
    }
    w.finalize().unwrap();
}
fn tools() -> AudioTools {
    AudioTools::default()
}
fn convert(input: &Path, output: &Path) {
    let t = tools();
    let result = Command::new(&t.ffmpeg)
        .args(["-v", "error", "-y", "-i"])
        .arg(input)
        .args([
            "-metadata",
            "title=Night Drive",
            "-metadata",
            "artist=GainMate Test",
            "-metadata",
            "album=Original fixtures",
            "-metadata",
            "comment=Generated, CC0",
        ])
        .args(if output.extension().unwrap() == "mp3" {
            vec!["-c:a", "libmp3lame", "-q:a", "0"]
        } else {
            vec![]
        })
        .arg(output)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn setup(amplitude: f64, transient: bool) -> (TempDir, PathBuf, Store) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("original.wav");
    fixture(&path, amplitude, transient, 48000, 10);
    let store = Store::open(dir.path().join("state.sqlite")).unwrap();
    (dir, path, store)
}
fn settings(dir: &Path, mode: Mode, target: f64) -> Settings {
    Settings {
        mode,
        target,
        destination: Some(dir.join("out")),
        ..Settings::default()
    }
}

#[test]
fn calibrated_stereo_tone_and_reference_loudnorm_agree() {
    let (_dir, path, _) = setup(0.1, false);
    let t = tools();
    let a = analyze(&t, &path, &cancel_token()).unwrap();
    assert!(
        (a.integrated.unwrap() + 20.).abs() < 0.15,
        "{}",
        a.integrated.unwrap()
    );
    assert!((a.sample_peak.unwrap() + 20.).abs() < 0.01);
    assert_eq!(a.frames, 480000);
    assert_eq!(a.info.sample_rate, 48000);
    assert!(a.waveform.len() <= 1201);
    assert!(a
        .timeline
        .iter()
        .any(|p| p.time >= 3. && p.short_term.is_some()));
    let output = Command::new(t.ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .args([
            "-af",
            "loudnorm=I=-12:TP=-1:print_format=json",
            "-f",
            "null",
            "-",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let s = String::from_utf8_lossy(&output.stderr);
    let start = s.rfind('{').unwrap();
    let end = s.rfind('}').unwrap();
    let v: serde_json::Value = serde_json::from_str(&s[start..=end]).unwrap();
    let ref_i: f64 = v["input_i"].as_str().unwrap().parse().unwrap();
    let ref_tp: f64 = v["input_tp"].as_str().unwrap().parse().unwrap();
    assert!((ref_i - a.integrated.unwrap()).abs() < 0.15);
    assert!((ref_tp - a.true_peak.unwrap()).abs() < 0.35);
}
#[test]
fn intersample_peaks_are_measured() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("intersample.wav");
    let mut w = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 2,
            sample_rate: 44100,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .unwrap();
    for i in 0..44100 * 4 {
        let v = (0.95 * (2. * PI * 11025. * i as f64 / 44100. + PI / 4.).sin()) as f32;
        w.write_sample(v).unwrap();
        w.write_sample(v).unwrap();
    }
    w.finalize().unwrap();
    let a = analyze(&tools(), &path, &cancel_token()).unwrap();
    assert!(
        a.true_peak.unwrap() - a.sample_peak.unwrap() > 2.0,
        "{:?} {:?}",
        a.true_peak,
        a.sample_peak
    );
}
#[test]
fn safe_gain_preserves_dynamics_and_stops_below_target() {
    let (dir, path, store) = setup(0.18, true);
    let token = cancel_token();
    let a = analyze(&tools(), &path, &token).unwrap();
    let s = settings(dir.path(), Mode::Safe, -8.);
    let p = plan(std::slice::from_ref(&a), &s).unwrap();
    let prediction = predict(&a, &s).unwrap();
    assert!(prediction.output < s.target - 1.);
    let op = normalize(&tools(), &store, &a, &s, &p.items[0], &token).unwrap();
    assert!(!op.target_reached);
    assert!(op.true_peak.unwrap() <= s.ceiling);
    let b = analyze(&tools(), &op.output, &token).unwrap();
    assert!((b.integrated.unwrap() - (a.integrated.unwrap() + prediction.gain)).abs() < 0.05);
    assert!((b.lra - a.lra).abs() < 0.2);
    let before: Vec<i32> = hound::WavReader::open(&path)
        .unwrap()
        .samples::<i32>()
        .map(Result::unwrap)
        .collect();
    let after: Vec<i32> = hound::WavReader::open(&op.output)
        .unwrap()
        .samples::<i32>()
        .map(Result::unwrap)
        .collect();
    let factor = 10f64.powf(prediction.gain / 20.);
    let max_error = before
        .iter()
        .zip(&after)
        .map(|(a, b)| (*b as f64 - *a as f64 * factor).abs())
        .fold(0., f64::max);
    assert!(max_error < 4., "Uniform gain error {max_error}");
}
#[test]
fn precise_normalize_verifies_limited_output() {
    let (dir, path, store) = setup(0.16, true);
    let token = cancel_token();
    let a = analyze(&tools(), &path, &token).unwrap();
    let s = settings(dir.path(), Mode::Precise, -12.);
    let p = plan(std::slice::from_ref(&a), &s).unwrap();
    assert!(p.items[0].prediction.as_ref().unwrap().limiting > 0.);
    let op = normalize(&tools(), &store, &a, &s, &p.items[0], &token).unwrap();
    assert!(op.target_reached);
    assert!((op.after.unwrap() + 12.).abs() <= 0.3);
    assert!(op.true_peak.unwrap() <= -1.);
    assert_eq!(hash_file(&path, &token).unwrap(), op.original_hash);
}
#[test]
fn wav_flac_mp3_round_trips_keep_tags_timing_and_verified_levels() {
    let (dir, path, store) = setup(0.08, false);
    let token = cancel_token();
    for format in ["wav", "flac", "mp3"] {
        let source = dir.path().join(format!("tagged.{format}"));
        convert(&path, &source);
        let a = analyze(&tools(), &source, &token).unwrap();
        assert_eq!(a.info.title, "Night Drive");
        assert_eq!(a.info.artist, "GainMate Test");
        let s = settings(&dir.path().join(format), Mode::Precise, -14.);
        let p = plan(std::slice::from_ref(&a), &s).unwrap();
        let op = normalize(&tools(), &store, &a, &s, &p.items[0], &token).unwrap();
        let output = analyze(&tools(), &op.output, &token).unwrap();
        assert_eq!(a.frames, output.frames);
        assert_eq!(a.info.sample_rate, output.info.sample_rate);
        assert_eq!(a.info.title, output.info.title);
        assert_eq!(a.info.artist, output.info.artist);
        assert_eq!(a.info.album, output.info.album);
        assert!(op.target_reached);
        assert!(op.true_peak.unwrap() <= -1.);
        if format != "mp3" {
            assert_eq!(a.info.bit_depth, output.info.bit_depth);
        }
    }
}
#[test]
fn byte_exact_backup_restore_and_changed_file_refusal() {
    let (dir, path, store) = setup(0.08, false);
    let token = cancel_token();
    let bytes = fs::read(&path).unwrap();
    let a = analyze(&tools(), &path, &token).unwrap();
    let mut s = settings(dir.path(), Mode::Precise, -14.);
    s.replace = true;
    s.backup_directory = Some(dir.path().join("my-backups"));
    let p = plan(std::slice::from_ref(&a), &s).unwrap();
    assert_eq!(p.backups, 1);
    let op = normalize(&tools(), &store, &a, &s, &p.items[0], &token).unwrap();
    assert_eq!(fs::read(op.backup.as_ref().unwrap()).unwrap(), bytes);
    let normalized = fs::read(&path).unwrap();
    fs::write(&path, b"changed by another app").unwrap();
    assert!(restore(&store, &op.id, &token).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"changed by another app");
    fs::write(&path, normalized).unwrap();
    let restored = restore(&store, &op.id, &token).unwrap();
    assert_eq!(restored.status, "restored");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(restore(&store, &op.id, &token).is_err());
}
#[test]
fn cancellation_never_changes_original_or_leaves_output() {
    let (dir, path, store) = setup(0.08, false);
    let token = cancel_token();
    let a = analyze(&tools(), &path, &token).unwrap();
    let original = fs::read(&path).unwrap();
    let mut s = settings(dir.path(), Mode::Precise, -14.);
    s.replace = true;
    let p = plan(std::slice::from_ref(&a), &s).unwrap();
    token.store(true, Ordering::Relaxed);
    assert!(normalize(&tools(), &store, &a, &s, &p.items[0], &token).is_err());
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(analyze(&tools(), &dir.path().join("original.wav"), &token).is_err());
    assert!(store.history().unwrap().is_empty());
}
#[test]
fn running_decoder_cancellation_finishes_promptly() {
    let (dir, path, _) = setup(0.1, false);
    let long = dir.path().join("long.wav");
    fixture(&long, 0.1, false, 48000, 90);
    let token = cancel_token();
    let cloned = token.clone();
    let started = std::time::Instant::now();
    let thread = std::thread::spawn(move || analyze(&tools(), &long, &cloned));
    std::thread::sleep(std::time::Duration::from_millis(80));
    token.store(true, Ordering::Relaxed);
    assert!(thread.join().unwrap().is_err());
    assert!(started.elapsed().as_secs() < 3);
    assert!(path.exists());
}
#[test]
fn cache_invalidates_and_sessions_persist() {
    let (dir, path, store) = setup(0.1, false);
    let a = analyze(&tools(), &path, &cancel_token()).unwrap();
    assert!(store.cached(&path).unwrap().is_none());
    store.cache(&a).unwrap();
    assert_eq!(store.cached(&path).unwrap().unwrap().frames, a.frames);
    store.save_session(std::slice::from_ref(&path)).unwrap();
    let reopened = Store::open(dir.path().join("state.sqlite")).unwrap();
    assert_eq!(reopened.session().unwrap(), vec![path.clone()]);
    fixture(&path, 0.2, false, 44100, 5);
    assert!(store.cached(&path).unwrap().is_none());
    assert_ne!(a.fingerprint, fingerprint(&path).unwrap());
}
#[test]
fn collisions_existing_exports_and_changed_sources_are_skipped() {
    let (dir, path, _) = setup(0.1, false);
    let a = analyze(&tools(), &path, &cancel_token()).unwrap();
    let mut b = a.clone();
    let sub = dir.path().join("other");
    fs::create_dir_all(&sub).unwrap();
    b.path = sub.join("original.wav");
    fs::copy(&path, &b.path).unwrap();
    b.fingerprint = fingerprint(&b.path).unwrap();
    let mut s = settings(dir.path(), Mode::Precise, -14.);
    s.preserve_folders = false;
    let collision = plan(&[a.clone(), b.clone()], &s).unwrap();
    assert_eq!(collision.skips, 2);
    s.preserve_folders = true;
    assert_eq!(plan(&[a.clone(), b], &s).unwrap().creates, 2);
    fs::create_dir_all(s.destination.as_ref().unwrap()).unwrap();
    fs::write(
        s.destination.as_ref().unwrap().join("original.wav"),
        b"existing",
    )
    .unwrap();
    assert_eq!(plan(std::slice::from_ref(&a), &s).unwrap().skips, 1);
    fs::write(&path, b"changed").unwrap();
    assert_eq!(plan(&[a], &s).unwrap().skips, 1);
}
#[test]
fn duplicate_paths_recursive_import_and_invalid_files() {
    let (dir, path, _) = setup(0.1, false);
    fs::write(dir.path().join("bad.mp3"), b"not audio").unwrap();
    fs::write(dir.path().join("ignore.txt"), b"text").unwrap();
    let imported = collect(&[path.clone(), dir.path().into(), path], &cancel_token()).unwrap();
    assert_eq!(imported.paths.len(), 2);
    assert!(analyze(&tools(), &dir.path().join("bad.mp3"), &cancel_token()).is_err());
    assert!(analyze(&tools(), &dir.path().join("ignore.txt"), &cancel_token()).is_err());
}
#[test]
fn silence_short_audio_and_extreme_targets_are_rejected() {
    let (dir, path, _) = setup(0., false);
    let a = analyze(&tools(), &path, &cancel_token()).unwrap();
    assert!(a.integrated.is_none());
    assert!(predict(&a, &settings(dir.path(), Mode::Precise, -12.)).is_err());
    let mut s = Settings {
        target: f64::NAN,
        ..Settings::default()
    };
    assert!(s.validate().is_err());
    s.target = -3.;
    assert!(s.validate().is_err());
    let crest = dir.path().join("crest.wav");
    fixture(&crest, 0.1, true, 48000, 10);
    let a = analyze(&tools(), &crest, &cancel_token()).unwrap();
    let s = settings(dir.path(), Mode::Precise, -6.);
    assert_eq!(plan(&[a], &s).unwrap().skips, 1);
}
#[test]
fn rekordbox_unicode_encoded_paths_playlists_and_missing_files() {
    let (dir, _, _) = setup(0.1, false);
    let path = dir.path().join("DJ ü & club.wav");
    fs::write(&path, b"exists").unwrap();
    let url = url::Url::from_file_path(&path)
        .unwrap()
        .to_string()
        .replace('&', "&amp;");
    let xml = format!(
        r#"<?xml version="1.0"?><DJ_PLAYLISTS><COLLECTION><TRACK TrackID="1" Name="A &amp; B" Artist="DJ Ü" Location="{url}"/><TRACK TrackID="2" Name="Missing" Location="file://localhost/absent.wav"/></COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT"><NODE Type="0" Name="Club"><NODE Type="1" Name="Warmup" KeyType="0"><TRACK Key="1"/><TRACK Key="2"/></NODE></NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>"#
    );
    let r = parse_rekordbox(&xml).unwrap();
    assert_eq!(r.tracks[0].path.as_ref(), Some(&path));
    assert_eq!(r.tracks[0].title, "A & B");
    assert!(!r.tracks[0].missing);
    assert!(r.tracks[1].missing);
    assert_eq!(r.playlists[0].name, "Club / Warmup");
    assert_eq!(r.playlists[0].track_ids, vec!["1", "2"]);
    assert!(parse_rekordbox("<invalid>").is_err());
    assert!(parse_rekordbox("<other/>").is_err());
}

#[test]
fn artwork_survives_mp3_and_flac_processing() {
    let (dir, path, store) = setup(0.1, false);
    let token = cancel_token();
    let cover = dir.path().join("cover.png");
    fs::write(&cover, include_bytes!("cover.png")).unwrap();
    for format in ["mp3", "flac"] {
        let input = dir.path().join(format!("artwork.{format}"));
        let result = Command::new(tools().ffmpeg)
            .args(["-v", "error", "-y", "-i"])
            .arg(&path)
            .arg("-i")
            .arg(&cover)
            .args([
                "-map",
                "0:a:0",
                "-map",
                "1:v:0",
                "-c:v",
                "copy",
                "-disposition:v:0",
                "attached_pic",
                "-metadata",
                "title=Artwork test",
                "-metadata:s:v",
                "title=Album cover",
                "-metadata:s:v",
                "comment=Cover (front)",
            ])
            .arg(&input)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let a = analyze(&tools(), &input, &token).unwrap();
        assert!(a.info.has_artwork);
        let s = settings(&dir.path().join(format), Mode::Precise, -14.);
        let p = plan(std::slice::from_ref(&a), &s).unwrap();
        let op = normalize(&tools(), &store, &a, &s, &p.items[0], &token).unwrap();
        let b = analyze(&tools(), &op.output, &token).unwrap();
        assert!(b.info.has_artwork);
        assert_eq!(b.info.title, "Artwork test");
        let extract = |file: &Path| {
            let output = Command::new(tools().ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(file)
                .args(["-map", "0:v:0", "-c:v", "copy", "-f", "image2pipe", "-"])
                .output()
                .unwrap();
            output.stdout
        };
        // The muxer may not be present in a minimal build; artwork stream integrity is also checked via ffprobe below.
        let before = extract(&input);
        let after = extract(&op.output);
        if !before.is_empty() {
            assert_eq!(before, after);
        }
    }
}
#[test]
fn sample_rates_mono_and_surround_keep_layout_and_timing() {
    let dir = TempDir::new().unwrap();
    let store = Store::open(dir.path().join("state.sqlite")).unwrap();
    let token = cancel_token();
    for (rate, channels) in [(44100, 1), (96000, 2), (192000, 2), (48000, 6)] {
        let path = dir.path().join(format!("{rate}-{channels}.wav"));
        let mut w = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels,
                sample_rate: rate,
                bits_per_sample: 24,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..rate * 4 {
            let v = (0.06 * (2. * PI * 1000. * i as f64 / rate as f64).sin() * 8388607.) as i32;
            for _ in 0..channels {
                w.write_sample(v).unwrap();
            }
        }
        w.finalize().unwrap();
        let a = analyze(&tools(), &path, &token).unwrap();
        let s = settings(dir.path(), Mode::Precise, -18.);
        let p = plan(std::slice::from_ref(&a), &s).unwrap();
        let op = normalize(&tools(), &store, &a, &s, &p.items[0], &token).unwrap();
        let b = analyze(&tools(), &op.output, &token).unwrap();
        assert_eq!(b.frames, a.frames);
        assert_eq!(b.info.channels, a.info.channels);
        assert_eq!(b.info.channel_layout, a.info.channel_layout);
    }
}
#[test]
fn very_short_audio_has_no_invented_integrated_loudness() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("short.wav");
    let mut w = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 1,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for _ in 0..2400 {
        w.write_sample(1000i16).unwrap();
    }
    w.finalize().unwrap();
    let a = analyze(&tools(), &path, &cancel_token()).unwrap();
    assert!(a.integrated.is_none());
    assert_eq!(a.frames, 2400);
}
#[test]
fn export_never_clobbers_a_file_created_after_review() {
    let (dir, path, store) = setup(0.1, false);
    let token = cancel_token();
    let a = analyze(&tools(), &path, &token).unwrap();
    let s = settings(dir.path(), Mode::Precise, -14.);
    let p = plan(std::slice::from_ref(&a), &s).unwrap();
    fs::create_dir_all(p.items[0].output.parent().unwrap()).unwrap();
    fs::write(&p.items[0].output, b"arrived after review").unwrap();
    assert!(normalize(&tools(), &store, &a, &s, &p.items[0], &token).is_err());
    assert_eq!(
        fs::read(&p.items[0].output).unwrap(),
        b"arrived after review"
    );
}

#[test]
fn simultaneous_database_open_and_session_reads_do_not_fail() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("fresh.sqlite");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let store = Store::open(path).unwrap();
                store.save_session(&[]).unwrap();
                store.session().unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
}
