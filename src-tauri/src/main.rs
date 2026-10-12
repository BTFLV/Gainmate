#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use gainmate_core::{
    analysis, import,
    model::*,
    normalize,
    process::{self, AudioTools, Cancel},
    store::Store,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};

struct Engine {
    tools: AudioTools,
    store: Store,
    cancel: Mutex<Cancel>,
    busy: Arc<AtomicBool>,
}
struct Job(Arc<AtomicBool>);
impl Drop for Job {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Engine {
    fn job(&self) -> Result<(Job, Cancel), String> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "A job is already running")?;
        let token = process::cancel_token();
        *self.cancel.lock().unwrap() = token.clone();
        Ok((Job(self.busy.clone()), token))
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackEvent {
    path: PathBuf,
    analysis: Option<Analysis>,
    operation: Option<Operation>,
    error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    completed: usize,
    total: usize,
    path: Option<PathBuf>,
}
fn summary(mut a: Analysis) -> Analysis {
    a.timeline.clear();
    a.waveform = a
        .waveform
        .chunks(a.waveform.len().div_ceil(64).max(1))
        .map(|c| c.iter().copied().fold(0f32, f32::max))
        .collect();
    a
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[tauri::command]
async fn import_paths(
    app: tauri::AppHandle,
    paths: Vec<PathBuf>,
) -> Result<import::Imported, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let e = app.state::<Engine>();
        let (_job, token) = e.job()?;
        let result = import::collect(&paths, &token).map_err(error)?;
        for path in &result.paths {
            app.asset_protocol_scope().allow_file(path).map_err(error)?;
        }
        Ok(result)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn read_rekordbox(path: PathBuf) -> Result<import::Rekordbox, String> {
    tauri::async_runtime::spawn_blocking(move || import::read_rekordbox(&path).map_err(error))
        .await
        .map_err(error)?
}
#[tauri::command]
async fn analyze_files(app: tauri::AppHandle, paths: Vec<PathBuf>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let e = app.state::<Engine>();
        let (_job, token) = e.job()?;
        let total = paths.len();
        let queue = Mutex::new(VecDeque::from(paths));
        let completed = Mutex::new(0usize);
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let token = &token;
                let queue = &queue;
                let completed = &completed;
                let e = &e;
                let app = &app;
                scope.spawn(move || loop {
                    if token.load(Ordering::Relaxed) {
                        break;
                    }
                    let Some(path) = queue.lock().unwrap().pop_front() else {
                        break;
                    };
                    let _ = app.emit(
                        "progress",
                        Progress {
                            phase: "Analyzing".into(),
                            completed: *completed.lock().unwrap(),
                            total,
                            path: Some(path.clone()),
                        },
                    );
                    let result = (|| -> anyhow::Result<Analysis> {
                        if let Some(a) = e.store.cached(&path)? {
                            return Ok(a);
                        }
                        let a = analysis::analyze(&e.tools, &path, token)?;
                        e.store.cache(&a)?;
                        Ok(a)
                    })();
                    let event = match result {
                        Ok(a) => TrackEvent {
                            path: path.clone(),
                            analysis: Some(summary(a)),
                            operation: None,
                            error: None,
                        },
                        Err(err) => TrackEvent {
                            path: path.clone(),
                            analysis: None,
                            operation: None,
                            error: Some(format!("{err:#}")),
                        },
                    };
                    let _ = app.emit("track", event);
                    let mut n = completed.lock().unwrap();
                    *n += 1;
                    let _ = app.emit(
                        "progress",
                        Progress {
                            phase: "Analyzing".into(),
                            completed: *n,
                            total,
                            path: Some(path),
                        },
                    );
                });
            }
        });
        Ok(())
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn track_detail(app: tauri::AppHandle, path: PathBuf) -> Result<Analysis, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Engine>()
            .store
            .cached(&path)
            .map_err(error)?
            .ok_or_else(|| "Analysis expired; analyze this track again".into())
    })
    .await
    .map_err(error)?
}
fn analyses(store: &Store, paths: &[PathBuf]) -> Result<Vec<Analysis>, String> {
    paths
        .iter()
        .map(|p| {
            store
                .cached(p)
                .map_err(error)?
                .map(summary)
                .ok_or_else(|| format!("Analyze {} first", p.display()))
        })
        .collect()
}
#[tauri::command]
async fn export_plan(
    app: tauri::AppHandle,
    paths: Vec<PathBuf>,
    settings: Settings,
) -> Result<Plan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let e = app.state::<Engine>();
        normalize::plan(&analyses(&e.store, &paths)?, &settings).map_err(error)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn normalize_files(
    app: tauri::AppHandle,
    paths: Vec<PathBuf>,
    settings: Settings,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let e = app.state::<Engine>();
        let (_job, token) = e.job()?;
        let all = analyses(&e.store, &paths)?;
        let plan = normalize::plan(&all, &settings).map_err(error)?;
        let total = plan.items.len();
        for (n, (item, source)) in plan.items.iter().zip(&all).enumerate() {
            if token.load(Ordering::Relaxed) {
                break;
            }
            let _ = app.emit(
                "progress",
                Progress {
                    phase: "Processing & verifying".into(),
                    completed: n,
                    total,
                    path: Some(source.path.clone()),
                },
            );
            let result = if let Some(skip) = &item.skip {
                Err(anyhow::anyhow!(skip.clone()))
            } else {
                normalize::normalize(&e.tools, &e.store, source, &settings, item, &token)
            };
            let event = match result {
                Ok(op) => {
                    let _ = app.asset_protocol_scope().allow_file(&op.output);
                    if let Some(backup) = &op.backup {
                        let _ = app.asset_protocol_scope().allow_file(backup);
                    }
                    TrackEvent {
                        path: source.path.clone(),
                        analysis: e.store.cached(&source.path).ok().flatten().map(summary),
                        operation: Some(op),
                        error: None,
                    }
                }
                Err(err) => TrackEvent {
                    path: source.path.clone(),
                    analysis: None,
                    operation: None,
                    error: Some(format!("{err:#}")),
                },
            };
            let _ = app.emit("track", event);
            let _ = app.emit(
                "progress",
                Progress {
                    phase: "Processing & verifying".into(),
                    completed: n + 1,
                    total,
                    path: Some(source.path.clone()),
                },
            );
        }
        Ok(())
    })
    .await
    .map_err(error)?
}
#[tauri::command]
fn cancel_job(engine: tauri::State<Engine>) {
    engine.cancel.lock().unwrap().store(true, Ordering::Relaxed);
}
#[tauri::command]
async fn history(app: tauri::AppHandle) -> Result<Vec<Operation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Engine>().store.history().map_err(error)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn restore_backup(app: tauri::AppHandle, id: String) -> Result<Operation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let e = app.state::<Engine>();
        let (_job, token) = e.job()?;
        normalize::restore(&e.store, &id, &token).map_err(error)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
fn save_session(engine: tauri::State<Engine>, paths: Vec<PathBuf>) -> Result<(), String> {
    engine.store.save_session(&paths).map_err(error)
}
#[tauri::command]
fn load_session(engine: tauri::State<Engine>) -> Result<Vec<PathBuf>, String> {
    engine.store.session().map_err(error)
}
fn tool_path(name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    if let Ok(current) = std::env::current_exe() {
        let sibling = current.parent().unwrap_or(Path::new(".")).join(&exe);
        if sibling.exists() {
            return sibling;
        }
    }
    #[cfg(debug_assertions)]
    {
        let target = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-apple-darwin"
            } else {
                "x86_64-apple-darwin"
            }
        } else if cfg!(windows) {
            "x86_64-pc-windows-msvc"
        } else {
            "x86_64-unknown-linux-gnu"
        };
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "{name}-{target}{}",
                if cfg!(windows) { ".exe" } else { "" }
            ));
        if path.exists() {
            return path;
        }
    }
    PathBuf::from(exe)
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = Store::open(app.path().app_data_dir()?.join("gainmate.sqlite"))?;
            app.manage(Engine {
                tools: AudioTools {
                    ffmpeg: tool_path("ffmpeg"),
                    ffprobe: tool_path("ffprobe"),
                },
                store,
                cancel: Mutex::new(process::cancel_token()),
                busy: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_paths,
            read_rekordbox,
            analyze_files,
            track_detail,
            export_plan,
            normalize_files,
            cancel_job,
            history,
            restore_backup,
            save_session,
            load_session
        ])
        .build(tauri::generate_context!())
        .expect("Could not start GainMate")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Engine>()
                    .cancel
                    .lock()
                    .unwrap()
                    .store(true, Ordering::Relaxed);
            }
        });
}
