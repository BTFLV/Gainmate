use crate::{model::*, process::*};
use anyhow::{Context, Result};
use ebur128::{Channel, EbuR128, Mode};
use serde_json::Value;
use std::{collections::BTreeMap, fs, io::Read, path::Path, process::Stdio, time::UNIX_EPOCH};

pub fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let m = fs::metadata(path)?;
    anyhow::ensure!(m.is_file(), "Not a regular audio file");
    Ok(Fingerprint {
        bytes: m.len(),
        modified_ns: m.modified()?.duration_since(UNIX_EPOCH)?.as_nanos(),
    })
}
pub fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|s| ["mp3", "wav", "flac"].contains(&s.to_ascii_lowercase().as_str()))
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.parse().ok())
}
fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}
fn db(x: f64) -> Option<f64> {
    finite(20. * x.log10())
}
pub fn probe(tools: &AudioTools, path: &Path, cancel: &Cancel) -> Result<AudioInfo> {
    anyhow::ensure!(supported(path), "Supported formats are MP3, WAV and FLAC");
    let output = capture(
        command(&tools.ffprobe)
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(path),
        cancel,
    )?;
    let json: Value = serde_json::from_str(&output)?;
    let streams = json["streams"].as_array().context("No streams found")?;
    let audio: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    anyhow::ensure!(audio.len() == 1, "Expected exactly one audio stream");
    let s = audio[0];
    let channels = number(&s["channels"]).context("Unknown channel count")? as u32;
    let sample_rate = number(&s["sample_rate"]).context("Unknown sample rate")? as u32;
    anyhow::ensure!(
        (1..=8).contains(&channels) && (8000..=384000).contains(&sample_rate),
        "Unsupported channel count or sample rate"
    );
    let layout = s["channel_layout"].as_str().unwrap_or(if channels == 1 {
        "mono"
    } else if channels == 2 {
        "stereo"
    } else {
        "unknown"
    });
    anyhow::ensure!(
        [
            "mono",
            "1 channels (FL)",
            "stereo",
            "2.1",
            "3.0",
            "4.0",
            "quad",
            "5.0",
            "5.0(side)",
            "5.1",
            "5.1(side)",
            "7.1"
        ]
        .contains(&layout),
        "Unsupported channel layout: {layout}"
    );
    let mut tags = BTreeMap::new();
    for t in [&json["format"]["tags"], &s["tags"]] {
        if let Some(t) = t.as_object() {
            for (k, v) in t {
                if let Some(v) = v.as_str() {
                    tags.insert(k.to_lowercase(), v.to_string());
                }
            }
        }
    }
    let duration = number(&s["duration"])
        .or_else(|| number(&json["format"]["duration"]))
        .context("Unknown duration")?;
    anyhow::ensure!(
        duration.is_finite() && duration > 0. && duration <= 24. * 3600.,
        "Invalid duration or audio longer than 24 hours"
    );
    Ok(AudioInfo {
        sample_rate,
        channels,
        channel_layout: layout.into(),
        codec: s["codec_name"].as_str().unwrap_or("unknown").into(),
        bit_depth: number(&s["bits_per_raw_sample"])
            .filter(|x| *x > 0.)
            .or_else(|| number(&s["bits_per_sample"]))
            .unwrap_or(0.) as u32,
        format: path.extension().unwrap().to_string_lossy().to_lowercase(),
        duration,
        title: tags.get("title").cloned().unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        }),
        artist: tags.get("artist").cloned().unwrap_or_default(),
        album: tags.get("album").cloned().unwrap_or_default(),
        has_artwork: streams
            .iter()
            .any(|s| s["disposition"]["attached_pic"] == 1),
        tags,
    })
}
fn channels(layout: &str) -> Vec<Channel> {
    use Channel::*;
    match layout {
        "mono" => vec![Center],
        "1 channels (FL)" => vec![Left],
        "stereo" => vec![Left, Right],
        "2.1" => vec![Left, Right, Unused],
        "3.0" => vec![Left, Right, Center],
        "4.0" => vec![Left, Right, Center, LeftSurround],
        "quad" => vec![Left, Right, LeftSurround, RightSurround],
        "5.0" | "5.0(side)" => vec![Left, Right, Center, LeftSurround, RightSurround],
        "5.1" | "5.1(side)" => vec![Left, Right, Center, Unused, LeftSurround, RightSurround],
        "7.1" => vec![
            Left,
            Right,
            Center,
            Unused,
            LeftSurround,
            RightSurround,
            LeftSurround,
            RightSurround,
        ],
        _ => vec![],
    }
}
pub fn analyze(tools: &AudioTools, path: &Path, cancel: &Cancel) -> Result<Analysis> {
    let path = path.canonicalize().context("Audio file not found")?;
    let original = fingerprint(&path)?;
    let mut info = probe(tools, &path, cancel)?;
    let mut meter = EbuR128::new(
        info.channels,
        info.sample_rate,
        Mode::I
            | Mode::S
            | Mode::M
            | Mode::LRA
            | Mode::TRUE_PEAK
            | Mode::SAMPLE_PEAK
            | Mode::HISTOGRAM,
    )?;
    for (i, c) in channels(&info.channel_layout).into_iter().enumerate() {
        meter.set_channel(i as u32, c)?;
    }
    let mut err = tempfile::tempfile()?;
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-threads", "1", "-i"])
        .arg(&path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(err.try_clone()?);
    let mut child = Running::spawn(&mut cmd, cancel)?;
    let mut stdout = child.stdout()?;
    let block_frames = (info.sample_rate / 10) as usize;
    let block_bytes = block_frames * info.channels as usize * 4;
    let mut bytes = vec![0u8; block_bytes];
    let mut samples = vec![0f32; block_bytes / 4];
    let waveform_frames = (info.duration * info.sample_rate as f64 / 1200.)
        .ceil()
        .max(1.) as u64;
    let timeline_step = (info.duration / 1800.).max(0.1);
    let mut next_point = 0.;
    let mut waveform = Vec::with_capacity(1200);
    let mut timeline = Vec::new();
    let mut frames = 0u64;
    let mut wave_count = 0;
    let mut wave_peak = 0f32;
    loop {
        check_cancel(cancel)?;
        let mut n = 0;
        while n < block_bytes {
            let read = stdout.read(&mut bytes[n..])?;
            if read == 0 {
                break;
            }
            n += read;
        }
        if n == 0 {
            break;
        }
        anyhow::ensure!(
            n % (4 * info.channels as usize) == 0,
            "Incomplete decoded audio frame"
        );
        for (s, b) in samples.iter_mut().zip(bytes[..n].as_chunks::<4>().0.iter()) {
            *s = f32::from_le_bytes(*b);
            anyhow::ensure!(s.is_finite(), "Non-finite audio samples");
        }
        let slice = &samples[..n / 4];
        meter.add_frames_f32(slice)?;
        for frame in slice.chunks_exact(info.channels as usize) {
            wave_peak = frame.iter().fold(wave_peak, |p, s| p.max(s.abs()));
            wave_count += 1;
            frames += 1;
            if wave_count >= waveform_frames {
                waveform.push(wave_peak);
                wave_count = 0;
                wave_peak = 0.;
            }
        }
        let time = frames as f64 / info.sample_rate as f64;
        if time >= next_point {
            timeline.push(LoudnessPoint {
                time,
                short_term: if time >= 3. {
                    finite(meter.loudness_shortterm()?)
                } else {
                    None
                },
                momentary: if time >= 0.4 {
                    finite(meter.loudness_momentary()?)
                } else {
                    None
                },
            });
            next_point = time + timeline_step;
        }
    }
    child
        .wait(cancel)
        .with_context(|| read_file(&mut err).unwrap_or_default())?;
    anyhow::ensure!(frames > 0, "No audio samples decoded");
    if wave_count > 0 {
        waveform.push(wave_peak);
    }
    anyhow::ensure!(
        original == fingerprint(&path)?,
        "File changed during analysis; retry"
    );
    info.duration = frames as f64 / info.sample_rate as f64;
    let mut true_peak = 0f64;
    let mut sample_peak = 0f64;
    for channel in 0..info.channels {
        true_peak = true_peak.max(meter.true_peak(channel)?);
        sample_peak = sample_peak.max(meter.sample_peak(channel)?);
    }
    let mut warnings = Vec::new();
    if info.format == "wav" {
        warnings.push("WAV audio encoding is preserved; nonstandard RIFF chunks, cue points and embedded artwork may not survive export.".into());
    }
    Ok(Analysis {
        path,
        fingerprint: original,
        info,
        integrated: finite(meter.loudness_global()?),
        true_peak: db(true_peak),
        sample_peak: db(sample_peak),
        lra: finite(meter.loudness_range()?).unwrap_or(0.),
        threshold: finite(meter.relative_threshold()?),
        waveform,
        timeline,
        frames,
        warnings,
    })
}
