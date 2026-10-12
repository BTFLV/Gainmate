use anyhow::{bail, Context, Result};
use std::{
    fs::File,
    io::{Read, Seek},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

pub type Cancel = Arc<AtomicBool>;
pub fn cancel_token() -> Cancel {
    Arc::new(AtomicBool::new(false))
}
pub fn check_cancel(cancel: &Cancel) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("Cancelled")
    }
    Ok(())
}
#[derive(Debug, Clone)]
pub struct AudioTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}
impl Default for AudioTools {
    fn default() -> Self {
        Self {
            ffmpeg: std::env::var_os("GAINMATE_FFMPEG")
                .map(PathBuf::from)
                .unwrap_or("ffmpeg".into()),
            ffprobe: std::env::var_os("GAINMATE_FFPROBE")
                .map(PathBuf::from)
                .unwrap_or("ffprobe".into()),
        }
    }
}
pub fn command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
pub struct Running {
    child: Arc<Mutex<Child>>,
    done: Arc<AtomicBool>,
    watcher: Option<thread::JoinHandle<()>>,
}
impl Running {
    pub fn spawn(cmd: &mut Command, cancel: &Cancel) -> Result<Self> {
        check_cancel(cancel)?;
        let child = Arc::new(Mutex::new(
            cmd.spawn()
                .context("Could not start the bundled audio tool")?,
        ));
        let done = Arc::new(AtomicBool::new(false));
        let (c, d, token) = (child.clone(), done.clone(), cancel.clone());
        let watcher = thread::spawn(move || {
            while !d.load(Ordering::Relaxed) {
                if token.load(Ordering::Relaxed) {
                    if let Ok(mut p) = c.lock() {
                        let _ = p.kill();
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(30));
            }
        });
        Ok(Self {
            child,
            done,
            watcher: Some(watcher),
        })
    }
    pub fn stdout(&self) -> Result<std::process::ChildStdout> {
        self.child
            .lock()
            .unwrap()
            .stdout
            .take()
            .context("Missing audio stream")
    }
    pub fn wait(&mut self, cancel: &Cancel) -> Result<()> {
        loop {
            if let Some(status) = self.child.lock().unwrap().try_wait()? {
                check_cancel(cancel)?;
                anyhow::ensure!(status.success(), "Audio tool failed ({status})");
                return Ok(());
            }
            thread::sleep(Duration::from_millis(30));
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Relaxed);
        {
            let mut c = self.child.lock().unwrap();
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(t) = self.watcher.take() {
            let _ = t.join();
        }
    }
}
pub fn capture(cmd: &mut Command, cancel: &Cancel) -> Result<String> {
    let mut out = tempfile::tempfile()?;
    let mut err = tempfile::tempfile()?;
    cmd.stdout(out.try_clone()?).stderr(err.try_clone()?);
    let mut running = Running::spawn(cmd, cancel)?;
    if let Err(e) = running.wait(cancel) {
        return Err(e.context(read_file(&mut err)?));
    }
    read_file(&mut out)
}
pub fn read_file(file: &mut File) -> Result<String> {
    file.rewind()?;
    let mut result = String::new();
    file.take(256 * 1024).read_to_string(&mut result)?;
    Ok(result)
}
