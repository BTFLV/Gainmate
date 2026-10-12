use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub bytes: u64,
    pub modified_ns: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_layout: String,
    pub codec: String,
    pub bit_depth: u32,
    pub format: String,
    pub duration: f64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub has_artwork: bool,
    pub tags: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessPoint {
    pub time: f64,
    pub short_term: Option<f64>,
    pub momentary: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub path: PathBuf,
    pub fingerprint: Fingerprint,
    pub info: AudioInfo,
    pub integrated: Option<f64>,
    pub true_peak: Option<f64>,
    pub sample_peak: Option<f64>,
    pub lra: f64,
    pub threshold: Option<f64>,
    pub waveform: Vec<f32>,
    pub timeline: Vec<LoudnessPoint>,
    pub frames: u64,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Precise,
    Safe,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub target: f64,
    pub ceiling: f64,
    pub mode: Mode,
    pub destination: Option<PathBuf>,
    pub replace: bool,
    pub backup: bool,
    pub backup_directory: Option<PathBuf>,
    pub preserve_folders: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            target: -12.,
            ceiling: -1.,
            mode: Mode::Precise,
            destination: None,
            replace: false,
            backup: true,
            backup_directory: None,
            preserve_folders: true,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.target.is_finite() && (-36.0..=-6.0).contains(&self.target),
            "Target must be between −36 and −6 LUFS"
        );
        anyhow::ensure!(
            self.ceiling.is_finite() && (-9.0..=0.0).contains(&self.ceiling),
            "True peak ceiling must be between −9 and 0 dBTP"
        );
        anyhow::ensure!(
            self.replace || self.destination.is_some(),
            "Choose an export folder"
        );
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub gain: f64,
    pub output: f64,
    pub limiting: f64,
    pub strategy: String,
    pub warning: Option<String>,
}
pub fn predict(a: &Analysis, settings: &Settings) -> anyhow::Result<Prediction> {
    let input = a
        .integrated
        .ok_or_else(|| anyhow::anyhow!("Silence or audio too short for integrated loudness"))?;
    let peak = a
        .true_peak
        .ok_or_else(|| anyhow::anyhow!("No measurable true peak"))?;
    let wanted = settings.target - input;
    let limiting = (peak + wanted - settings.ceiling).max(0.);
    let gain = if settings.mode == Mode::Safe {
        wanted.min(settings.ceiling - peak - 0.05)
    } else {
        wanted
    };
    Ok(Prediction {
        gain,
        output: input + gain,
        limiting: if settings.mode == Mode::Precise {
            limiting
        } else {
            0.
        },
        strategy: if settings.mode == Mode::Safe && gain < wanted - 0.05 {
            "Peak constrained gain"
        } else if limiting > 0. && settings.mode == Mode::Precise {
            "Gain + true peak limiting"
        } else {
            "Uniform gain"
        }
        .into(),
        warning: if settings.mode == Mode::Precise && limiting > 6. {
            Some("More than 6 dB of peak reduction would be required. Choose a quieter target or Safe Gain.".into())
        } else if a.info.format == "mp3" {
            Some("MP3 is decoded and encoded with LAME V0; this is a lossy generation.".into())
        } else {
            None
        },
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub source: PathBuf,
    pub output: PathBuf,
    pub prediction: Option<Prediction>,
    pub skip: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub items: Vec<PlanItem>,
    pub creates: usize,
    pub overwrites: usize,
    pub backups: usize,
    pub skips: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub timestamp: u64,
    pub source: PathBuf,
    pub output: PathBuf,
    pub backup: Option<PathBuf>,
    pub original_hash: String,
    pub output_hash: String,
    pub before: Option<f64>,
    pub after: Option<f64>,
    pub true_peak: Option<f64>,
    pub target: f64,
    pub target_reached: bool,
    pub status: String,
    pub message: String,
    pub mode: Mode,
}
