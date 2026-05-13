use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const BACKEND_PORT: u16 = 3000;
const BACKEND_READY_TIMEOUT: Duration = Duration::from_secs(20);
const BACKEND_POLL_INTERVAL: Duration = Duration::from_millis(250);
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_millis(700);
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_REDIRECT_URI: &str = "https://sc-auth-redirect.web.app";

pub struct BackendState {
    child: Mutex<Option<Child>>,
    runtime_dir: PathBuf,
    logs_dir: PathBuf,
    database_path: PathBuf,
}

impl BackendState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let runtime_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data dir: {error}"))?
            .join("backend");
        let logs_dir = runtime_dir.join("logs");
        let database_path = runtime_dir.join("soundcloud-desktop.sqlite");

        fs::create_dir_all(&logs_dir)
            .map_err(|error| format!("Failed to create backend runtime dir: {error}"))?;

        Ok(Self {
            child: Mutex::new(None),
            runtime_dir,
            logs_dir,
            database_path,
        })
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        if Self::healthcheck() {
            self.append_startup_log("Reusing already-running backend on localhost:3000");
            return Ok(());
        }

        self.append_startup_log(&format!(
            "Backend bootstrap requested. runtime_dir={} database_path={}",
            self.runtime_dir.display(),
            self.database_path.display()
        ));

        let mut child_lock = self
            .child
            .lock()
            .map_err(|_| "Failed to lock backend child process state".to_string())?;

        if let Some(child) = child_lock.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    self.wait_until_ready(&mut *child_lock)?;
                    return Ok(());
                }
                Ok(Some(_)) | Err(_) => {
                    *child_lock = None;
                }
            }
        }

        let (command, args) = self.resolve_command(app)?;
        self.append_startup_log(&format!(
            "Launching backend command={} args={:?}",
            command.display(),
            args
        ));
        let stdout_log = self.logs_dir.join("backend.out.log");
        let stderr_log = self.logs_dir.join("backend.err.log");
        let stdout_file = File::create(&stdout_log)
            .map_err(|error| format!("Failed to create backend stdout log: {error}"))?;
        let stderr_file = File::create(&stderr_log)
            .map_err(|error| format!("Failed to create backend stderr log: {error}"))?;

        let mut cmd = Command::new(&command);
        cmd.args(&args)
            .current_dir(&self.runtime_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(stderr_file))
            .env("PORT", BACKEND_PORT.to_string())
            .env("DATABASE_PATH", &self.database_path);

        if std::env::var_os("SOUNDCLOUD_REDIRECT_URI").is_none() {
            cmd.env("SOUNDCLOUD_REDIRECT_URI", DEFAULT_REDIRECT_URI);
        }

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(WINDOWS_CREATE_NO_WINDOW);
        }

        let child = cmd.spawn().map_err(|error| {
            format!(
                "Failed to launch bundled backend `{}`: {error}",
                command.display()
            )
        })?;

        self.append_startup_log(&format!(
            "Spawned backend pid={} stdout_log={} stderr_log={}",
            child.id(),
            stdout_log.display(),
            stderr_log.display()
        ));
        *child_lock = Some(child);
        if let Err(error) = self.wait_until_ready(&mut *child_lock) {
            if let Some(child) = child_lock.as_mut() {
                let _ = child.kill();
            }
            *child_lock = None;
            self.append_startup_log(&format!("Backend bootstrap failed: {error}"));
            return Err(error);
        }

        self.append_startup_log("Backend healthcheck succeeded");
        Ok(())
    }

    fn wait_until_ready(&self, child_slot: &mut Option<Child>) -> Result<(), String> {
        let deadline = Instant::now() + BACKEND_READY_TIMEOUT;

        while Instant::now() < deadline {
            if Self::healthcheck() {
                return Ok(());
            }

            if let Some(child) = child_slot.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    let message = format!(
                        "Embedded backend exited before becoming ready (status: {status}). Check backend.err.log in {}",
                        self.logs_dir.display()
                    );
                    self.append_startup_log(&message);
                    return Err(message);
                }
            }

            thread::sleep(BACKEND_POLL_INTERVAL);
        }

        let message = format!(
            "Embedded backend did not become ready on http://127.0.0.1:{BACKEND_PORT}/health within {}s. Check logs in {}",
            BACKEND_READY_TIMEOUT.as_secs(),
            self.logs_dir.display()
        );
        self.append_startup_log(&message);
        Err(message)
    }

    fn healthcheck() -> bool {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, BACKEND_PORT));
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, HEALTHCHECK_TIMEOUT) else {
            return false;
        };

        let _ = stream.set_read_timeout(Some(HEALTHCHECK_TIMEOUT));
        let _ = stream.set_write_timeout(Some(HEALTHCHECK_TIMEOUT));

        if stream
            .write_all(
                b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
            .is_err()
        {
            return false;
        }

        let mut response = String::new();
        if stream.read_to_string(&mut response).is_err() {
            return false;
        }

        response.contains(" 200 ")
            && response.contains("\"status\":\"ok\"")
            && response.contains("application/json")
    }

    fn resolve_command(&self, app: &AppHandle) -> Result<(PathBuf, Vec<String>), String> {
        #[cfg(debug_assertions)]
        let _ = app;

        #[cfg(debug_assertions)]
        {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let repo_root = manifest_dir
                .parent()
                .and_then(|path| path.parent())
                .ok_or_else(|| "Failed to resolve repository root from Cargo manifest dir".to_string())?;
            let backend_entry = repo_root.join("backend").join("dist").join("main.js");
            if !backend_entry.exists() {
                return Err(format!(
                    "Backend dist entry was not found at {}. Build the backend before launching the desktop app.",
                    backend_entry.display()
                ));
            }

            return Ok((
                PathBuf::from(if cfg!(target_os = "windows") {
                    "node.exe"
                } else {
                    "node"
                }),
                vec![backend_entry.to_string_lossy().into_owned()],
            ));
        }

        #[cfg(not(debug_assertions))]
        {
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|error| format!("Failed to resolve Tauri resource dir: {error}"))?;
            let current_exe = std::env::current_exe()
                .map_err(|error| format!("Failed to resolve current executable path: {error}"))?;
            let exe_dir = current_exe.parent().ok_or_else(|| {
                format!(
                    "Failed to resolve executable directory from {}",
                    current_exe.display()
                )
            })?;

            let mut candidate_dirs = Vec::new();
            for candidate in [
                resource_dir.join("backend"),
                resource_dir.join("resources").join("backend"),
                exe_dir.join("backend"),
                exe_dir.join("resources").join("backend"),
            ] {
                if !candidate_dirs.contains(&candidate) {
                    candidate_dirs.push(candidate);
                }
            }

            self.append_startup_log(&format!(
                "Release resource lookup: resource_dir={} current_exe={} candidates={}",
                resource_dir.display(),
                current_exe.display(),
                candidate_dirs
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));

            for backend_dir in candidate_dirs {
                let node_binary = backend_dir.join(if cfg!(target_os = "windows") {
                    "node.exe"
                } else {
                    "node"
                });
                let backend_entry = backend_dir.join("dist").join("main.js");

                if node_binary.exists() && backend_entry.exists() {
                    self.append_startup_log(&format!(
                        "Resolved bundled backend directory at {}",
                        backend_dir.display()
                    ));
                    let node_binary = normalize_process_path(&node_binary);
                    let backend_entry = normalize_process_path(&backend_entry);
                    return Ok((node_binary, vec![backend_entry.to_string_lossy().into_owned()]));
                }
            }

            return Err(format!(
                "Bundled backend runtime was not found. Expected one of: {}",
                [
                    resource_dir.join("backend"),
                    resource_dir.join("resources").join("backend"),
                    exe_dir.join("backend"),
                    exe_dir.join("resources").join("backend"),
                ]
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" | ")
            ));
        }
    }

    fn append_startup_log(&self, message: &str) {
        let _ = append_startup_log_file(&self.logs_dir, message);
    }
}

impl Drop for BackendState {
    fn drop(&mut self) {
        if let Ok(mut child_lock) = self.child.lock() {
            if let Some(child) = child_lock.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

fn append_startup_log_file(logs_dir: &Path, message: &str) -> std::io::Result<()> {
    fs::create_dir_all(logs_dir)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("startup.log"))?;
    writeln!(file, "[{timestamp}] {message}")?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn normalize_process_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

#[cfg(not(target_os = "windows"))]
fn normalize_process_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}
