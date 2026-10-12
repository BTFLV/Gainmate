use crate::{
    analysis::{analyze, fingerprint},
    model::*,
    process::*,
    store::Store,
};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

fn relative_export_path(path: &Path, root: &Path) -> std::path::PathBuf {
    if let Ok(relative) = path.strip_prefix(root) {
        if !relative.is_absolute() {
            return relative.to_path_buf();
        }
    }
    let mut relative = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => relative.push(
                prefix
                    .as_os_str()
                    .to_string_lossy()
                    .replace([':', '?', '\\', '/'], "_"),
            ),
            std::path::Component::Normal(part) => relative.push(part),
            _ => {}
        }
    }
    relative
}

pub fn plan(analyses: &[Analysis], settings: &Settings) -> Result<Plan> {
    settings.validate()?;
    let mut root = analyses
        .first()
        .and_then(|a| a.path.parent())
        .unwrap_or(Path::new(""))
        .to_path_buf();
    while analyses.iter().any(|a| !a.path.starts_with(&root)) {
        if !root.pop() {
            root.clear();
            break;
        }
    }
    let mut items = Vec::new();
    for a in analyses {
        let output = if settings.replace {
            a.path.clone()
        } else {
            let relative = if settings.preserve_folders {
                relative_export_path(&a.path, &root)
            } else {
                a.path.file_name().context("Missing filename")?.into()
            };
            settings.destination.as_ref().unwrap().join(relative)
        };
        let prediction = predict(a, settings);
        let skip = if !settings.replace && output.exists() {
            Some("Destination exists; GainMate never overwrites exports".into())
        } else if fingerprint(&a.path).ok().as_ref() != Some(&a.fingerprint) {
            Some("Source changed or disappeared; analyze again".into())
        } else if let Err(e) = &prediction {
            Some(e.to_string())
        } else if settings.mode == Mode::Precise && prediction.as_ref().unwrap().limiting > 6. {
            Some("Required peak reduction exceeds 6 dB; lower target or use Safe Gain".into())
        } else {
            None
        };
        items.push(PlanItem {
            source: a.path.clone(),
            output,
            prediction: prediction.ok(),
            skip,
        });
    }
    let mut destinations = HashMap::new();
    for i in &items {
        *destinations
            .entry(i.output.to_string_lossy().to_lowercase())
            .or_insert(0) += 1;
    }
    for i in &mut items {
        if destinations[&i.output.to_string_lossy().to_lowercase()] > 1 {
            i.skip = Some("Filename collision between selected tracks".into());
        }
    }
    let skips = items.iter().filter(|i| i.skip.is_some()).count();
    let count = items.len() - skips;
    Ok(Plan {
        items,
        creates: if settings.replace { 0 } else { count },
        overwrites: if settings.replace { count } else { 0 },
        backups: if settings.replace && settings.backup {
            count
        } else {
            0
        },
        skips,
    })
}
pub fn hash_file(path: &Path, cancel: &Cancel) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        check_cancel(cancel)?;
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}
fn encode(
    tools: &AudioTools,
    source: &Analysis,
    output: &Path,
    filter: &str,
    cancel: &Cancel,
) -> Result<()> {
    let mut cmd = command(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-i",
    ])
    .arg(&source.path)
    .args([
        "-map",
        "0:a:0",
        "-map_metadata",
        "0",
        "-af",
        filter,
        "-ar",
        &source.info.sample_rate.to_string(),
        "-threads",
        "1",
    ]);
    match source.info.format.as_str() {
        "mp3" => {
            cmd.args([
                "-map",
                "0:v?",
                "-c:v",
                "copy",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "0",
                "-id3v2_version",
                "3",
                "-write_xing",
                "1",
            ]);
        }
        "flac" => {
            cmd.args([
                "-map",
                "0:v?",
                "-c:v",
                "copy",
                "-c:a",
                "flac",
                "-compression_level",
                "5",
            ]);
            if source.info.bit_depth > 16 {
                cmd.args(["-sample_fmt", "s32"]);
            }
        }
        "wav" => {
            anyhow::ensure!(
                [
                    "pcm_s16le",
                    "pcm_s24le",
                    "pcm_s32le",
                    "pcm_u8",
                    "pcm_f32le",
                    "pcm_f64le"
                ]
                .contains(&source.info.codec.as_str()),
                "Unsupported WAV codec: {}",
                source.info.codec
            );
            cmd.args(["-c:a", &source.info.codec, "-rf64", "auto"]);
        }
        _ => anyhow::bail!("Unsupported format"),
    }
    // ReplayGain is stale after samples change and must not mislead players.
    for tag in [
        "replaygain_track_gain",
        "replaygain_track_peak",
        "replaygain_album_gain",
        "replaygain_album_peak",
        "R128_TRACK_GAIN",
        "R128_ALBUM_GAIN",
    ] {
        cmd.args(["-metadata", &format!("{tag}=")]);
    }
    cmd.arg(output);
    capture(&mut cmd, cancel)?;
    Ok(())
}
fn verify_integrity(before: &Analysis, after: &Analysis) -> Result<()> {
    anyhow::ensure!(
        before.info.sample_rate == after.info.sample_rate
            && before.info.channels == after.info.channels
            && before.info.channel_layout == after.info.channel_layout,
        "Output changed sample rate or channel layout"
    );
    anyhow::ensure!(
        before.frames == after.frames,
        "Output timing changed: {} input frames vs {} output frames",
        before.frames,
        after.frames
    );
    for tag in ["title", "artist", "album"] {
        if let Some(value) = before.info.tags.get(tag) {
            anyhow::ensure!(
                after.info.tags.get(tag) == Some(value),
                "Output lost {tag} metadata"
            );
        }
    }
    if before.info.has_artwork && before.info.format != "wav" {
        anyhow::ensure!(after.info.has_artwork, "Output lost embedded artwork");
    }
    Ok(())
}
fn copy_durable(source: &Path, dest: &Path, cancel: &Cancel) -> Result<()> {
    fs::create_dir_all(dest.parent().context("No backup parent")?)?;
    let mut tmp = NamedTempFile::new_in(dest.parent().unwrap())?;
    let mut input = File::open(source)?;
    let mut buf = vec![0; 128 * 1024];
    loop {
        check_cancel(cancel)?;
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        tmp.write_all(&buf[..n])?;
    }
    tmp.as_file().sync_all()?;
    tmp.persist_noclobber(dest).map_err(|e| e.error)?;
    sync_parent(dest)?;
    Ok(())
}
fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path.parent().context("Missing parent folder")?)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
pub fn normalize(
    tools: &AudioTools,
    store: &Store,
    source: &Analysis,
    settings: &Settings,
    item: &PlanItem,
    cancel: &Cancel,
) -> Result<Operation> {
    check_cancel(cancel)?;
    settings.validate()?;
    let id = Uuid::new_v4().to_string();
    match normalize_inner(tools, store, source, settings, item, cancel, id.clone()) {
        Ok(op) => Ok(op),
        Err(error) => {
            let mut op = store.operation(&id)?.unwrap_or(Operation {
                id,
                timestamp: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
                source: source.path.clone(),
                output: item.output.clone(),
                backup: None,
                original_hash: String::new(),
                output_hash: String::new(),
                before: source.integrated,
                after: None,
                true_peak: None,
                target: settings.target,
                target_reached: false,
                status: "failed".into(),
                message: String::new(),
                mode: settings.mode,
            });
            // A post-rename error must not misreport a committed, verified file as untouched.
            let committed = !op.output_hash.is_empty()
                && hash_file(&op.output, &crate::process::cancel_token())
                    .ok()
                    .as_ref()
                    == Some(&op.output_hash);
            op.status = if committed {
                "complete"
            } else if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            op.message = if committed {
                format!("Verified file committed; final bookkeeping warning: {error:#}")
            } else {
                format!("{error:#}")
            };
            store.record(&op)?;
            if committed {
                Ok(op)
            } else {
                Err(error)
            }
        }
    }
}

fn normalize_inner(
    tools: &AudioTools,
    store: &Store,
    source: &Analysis,
    settings: &Settings,
    item: &PlanItem,
    cancel: &Cancel,
    id: String,
) -> Result<Operation> {
    check_cancel(cancel)?;
    settings.validate()?;
    anyhow::ensure!(
        item.skip.is_none(),
        "This track was skipped in the export plan"
    );
    anyhow::ensure!(
        source.path == item.source && source.fingerprint == fingerprint(&source.path)?,
        "Source changed; analyze again"
    );
    let prediction = predict(source, settings)?;
    anyhow::ensure!(
        settings.mode != Mode::Precise || prediction.limiting <= 6.,
        "Required peak reduction exceeds the quality safety limit"
    );
    let parent = item.output.parent().context("No output directory")?;
    fs::create_dir_all(parent)?;
    let tmp = tempfile::Builder::new()
        .prefix(".gainmate-")
        .suffix(&format!(".{}", source.info.format))
        .tempfile_in(parent)?;
    let original_hash = hash_file(&source.path, cancel)?;
    let lossy = source.info.format == "mp3";
    let mut gain = prediction.gain;
    let mut ceiling = settings.ceiling - if lossy { 0.4 } else { 0.08 };
    let mut working_target = settings.target;
    let limiting = settings.mode == Mode::Precise && source.true_peak.unwrap() + gain > ceiling;
    let mut verified = None;
    for attempt in 0..4 {
        check_cancel(cancel)?;
        let filter = if limiting {
            format!("loudnorm=I={working_target}:TP={ceiling}:LRA=50:linear=false:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset=0,aresample={}", source.integrated.unwrap(), source.true_peak.unwrap(), source.lra.clamp(0.,99.), source.threshold.unwrap_or(-70.), source.info.sample_rate)
        } else {
            format!("volume={gain}dB:precision=double,aresample=dither_method=triangular")
        };
        encode(tools, source, tmp.path(), &filter, cancel)?;
        let result = analyze(tools, tmp.path(), cancel)?;
        verify_integrity(source, &result)?;
        let measured_peak = result
            .true_peak
            .context("Output contains no measurable audio")?;
        let measured_i = result
            .integrated
            .context("Output has no integrated loudness")?;
        if measured_peak > settings.ceiling {
            let correction = measured_peak - settings.ceiling + 0.1;
            ceiling -= correction;
            gain -= correction;
            anyhow::ensure!(
                ceiling >= -9.,
                "Encoder overshoot could not be controlled safely"
            );
        } else if settings.mode == Mode::Precise
            && (measured_i - settings.target).abs() > 0.3
            && attempt < 3
        {
            let correction = (settings.target - measured_i).clamp(-2., 2.);
            if limiting {
                working_target = (working_target + correction).clamp(-36., -5.);
            } else if measured_peak + correction <= settings.ceiling {
                gain += correction;
            } else {
                verified = Some(result);
                break;
            }
        } else {
            verified = Some(result);
            break;
        }
    }
    let verified = verified
        .context("Output failed true peak verification after four attempts; source unchanged")?;
    anyhow::ensure!(
        verified.true_peak.unwrap() <= settings.ceiling,
        "Output exceeds the true peak ceiling"
    );
    let target_reached = (verified.integrated.unwrap() - settings.target).abs() <= 0.3;
    // Precise mode never commits a substantially missed target.
    anyhow::ensure!(settings.mode == Mode::Safe || target_reached, "Precise target could not be verified within 0.3 LU (achieved {:.2} LUFS); choose a quieter target or Safe Gain", verified.integrated.unwrap());
    check_cancel(cancel)?;
    anyhow::ensure!(
        hash_file(&source.path, cancel)? == original_hash,
        "Source changed during processing; nothing replaced"
    );
    let backup = if settings.replace && settings.backup {
        let root = settings
            .backup_directory
            .clone()
            .unwrap_or_else(|| parent.join(".gainmate-backups"));
        let p = root.join(&id).join(source.path.file_name().unwrap());
        copy_durable(&source.path, &p, cancel)?;
        anyhow::ensure!(
            hash_file(&p, cancel)? == original_hash,
            "Backup verification failed"
        );
        Some(p)
    } else {
        None
    };
    let output_hash = hash_file(tmp.path(), cancel)?;
    let mut operation = Operation {
        id,
        timestamp: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        source: source.path.clone(),
        output: item.output.clone(),
        backup,
        original_hash,
        output_hash,
        before: source.integrated,
        after: verified.integrated,
        true_peak: verified.true_peak,
        target: settings.target,
        target_reached,
        status: "prepared".into(),
        message: if target_reached {
            "Target and true peak verified"
        } else {
            "Peak ceiling verified; Safe Gain stopped below target"
        }
        .into(),
        mode: settings.mode,
    };
    tmp.as_file().sync_all()?;
    fs::set_permissions(tmp.path(), fs::metadata(&source.path)?.permissions())?;
    store.record(&operation)?;
    check_cancel(cancel)?;
    // Commit boundary: after this point finish the journal even if cancellation arrives.
    if settings.replace {
        anyhow::ensure!(
            fingerprint(&source.path)? == source.fingerprint,
            "Source changed before replacement"
        );
        tmp.persist(&item.output)
            .map_err(|e| e.error)
            .context("Atomic replacement failed; original retained")?;
    } else {
        tmp.persist_noclobber(&item.output)
            .map_err(|e| e.error)
            .context("Export destination appeared during processing; not overwritten")?;
    }
    sync_parent(&item.output)?;
    operation.status = "complete".into();
    store.record(&operation)?;
    let mut cached = verified;
    cached.path = item.output.canonicalize()?;
    cached.fingerprint = fingerprint(&cached.path)?;
    store.cache(&cached)?;
    Ok(operation)
}
pub fn restore(store: &Store, id: &str, cancel: &Cancel) -> Result<Operation> {
    let mut operation = store.operation(id)?.context("Operation not found")?;
    anyhow::ensure!(
        operation.status == "complete" || operation.status == "prepared",
        "This backup has already been restored"
    );
    let backup = operation
        .backup
        .as_ref()
        .context("No backup exists for this operation")?;
    anyhow::ensure!(
        hash_file(&operation.output, cancel)? == operation.output_hash,
        "Current file changed after normalization. Restore refused to protect those changes."
    );
    anyhow::ensure!(
        hash_file(backup, cancel)? == operation.original_hash,
        "Backup changed or is damaged; restore refused"
    );
    let mut tmp = NamedTempFile::new_in(operation.output.parent().unwrap())?;
    let mut source = File::open(backup)?;
    std::io::copy(&mut source, &mut tmp)?;
    tmp.as_file().sync_all()?;
    fs::set_permissions(tmp.path(), fs::metadata(&operation.output)?.permissions())?;
    check_cancel(cancel)?;
    anyhow::ensure!(
        hash_file(&operation.output, cancel)? == operation.output_hash,
        "Current file changed during restore"
    );
    tmp.persist(&operation.output).map_err(|e| e.error)?;
    sync_parent(&operation.output)?;
    operation.status = "restored".into();
    operation.message = "Original bytes restored and verified".into();
    store.record(&operation)?;
    Ok(operation)
}
