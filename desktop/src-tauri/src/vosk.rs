use futures_util::{SinkExt, StreamExt};
use reqwest::{
    header::CONTENT_TYPE,
    multipart::{Form, Part},
    Client, Url,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Cursor},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use symphonia::{
    core::{
        audio::SampleBuffer,
        codecs::{DecoderOptions, CODEC_TYPE_NULL},
        errors::Error as SymphoniaError,
        formats::FormatOptions,
        io::MediaSourceStream,
        meta::MetadataOptions,
        probe::Hint,
    },
    default::{get_codecs, get_probe},
};
use tauri::Manager;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
};

const DEFAULT_VOSK_URL: &str = "ws://127.0.0.1:2700";
const DEFAULT_VOSK_READY_TIMEOUT_MS: u64 = 12_000;
const DEFAULT_DOCKER_VOSK_READY_TIMEOUT_MS: u64 = 120_000;
const MAX_AUDIO_BYTES: usize = 40 * 1024 * 1024;
const TARGET_SAMPLE_RATE: u32 = 16_000;
const WS_CHUNK_MILLIS: usize = 200;

#[derive(Clone, Debug)]
struct VoskConfig {
    enabled: bool,
    autostart: bool,
    endpoint: String,
    command: Option<String>,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    ready_timeout_ms: u64,
    api_key: String,
}

#[derive(Serialize)]
pub struct VoskStatus {
    enabled: bool,
    autostart: bool,
    running: bool,
    endpoint: String,
    launched_by_app: bool,
}

pub struct VoskState {
    config: VoskConfig,
    child: Mutex<Option<Child>>,
    launched_by_app: Mutex<bool>,
    http_client: Client,
}

#[cfg(debug_assertions)]
fn debug_log(message: impl AsRef<str>) {
    println!("[Vosk] {}", message.as_ref());
}

#[cfg(not(debug_assertions))]
fn debug_log(_message: impl AsRef<str>) {}

#[cfg(debug_assertions)]
fn debug_warn(message: impl AsRef<str>) {
    eprintln!("[Vosk] {}", message.as_ref());
}

#[cfg(not(debug_assertions))]
fn debug_warn(_message: impl AsRef<str>) {}

impl Drop for VoskState {
    fn drop(&mut self) {
        if let Ok(mut child_lock) = self.child.lock() {
            if let Some(child) = child_lock.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

impl VoskState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let config = load_vosk_config(&app);
        debug_log(format!(
            "config loaded: enabled={}, autostart={}, endpoint={}, command={:?}, cwd={:?}, args={:?}",
            config.enabled, config.autostart, config.endpoint, config.command, config.cwd, config.args
        ));
        Self {
            config,
            child: Mutex::new(None),
            launched_by_app: Mutex::new(false),
            http_client: Client::new(),
        }
    }

    pub fn autostart_if_enabled(self: &Arc<Self>) {
        if !self.config.enabled || !self.config.autostart {
            debug_log(format!(
                "autostart skipped: enabled={}, autostart={}",
                self.config.enabled, self.config.autostart
            ));
            return;
        }

        match self.spawn_sidecar_if_needed() {
            Ok(()) => debug_log("autostart sidecar spawn requested"),
            Err(err) => debug_warn(format!("autostart failed: {err}")),
        }
    }

    pub fn status_snapshot(&self) -> VoskStatus {
        VoskStatus {
            enabled: self.config.enabled,
            autostart: self.config.autostart,
            running: self.is_child_alive(),
            endpoint: self.config.endpoint.clone(),
            launched_by_app: self.launched_by_app.lock().map(|flag| *flag).unwrap_or(false),
        }
    }

    async fn sync_from_stream_url(
        &self,
        stream_url: String,
        plain_lyrics: String,
        track_urn: Option<String>,
        artist: Option<String>,
        title: Option<String>,
    ) -> Result<Value, String> {
        debug_log(format!(
            "sync request: track={:?}, artist={:?}, title={:?}, lyrics_len={}",
            track_urn,
            artist,
            title,
            plain_lyrics.len()
        ));

        if !self.config.enabled {
            debug_warn("sync aborted: Vosk ASR is disabled");
            return Err("Vosk ASR is disabled".into());
        }
        if plain_lyrics.trim().is_empty() {
            debug_warn("sync aborted: plain lyrics are empty");
            return Err("Plain lyrics are empty".into());
        }

        self.ensure_ready().await?;
        debug_log(format!("sync fetching stream: {stream_url}"));

        let stream_response = self
            .http_client
            .get(&stream_url)
            .send()
            .await
            .map_err(|err| {
                let message = format!("Failed to fetch track stream: {err}");
                debug_warn(&message);
                message
            })?;

        if !stream_response.status().is_success() {
            let message = format!("Track stream request failed: {}", stream_response.status());
            debug_warn(&message);
            return Err(message);
        }

        let content_type = stream_response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("audio/mpeg")
            .to_string();
        let audio_bytes = read_response_bytes_limited(stream_response, MAX_AUDIO_BYTES).await?;
        debug_log(format!(
            "stream downloaded: bytes={}, content_type={}",
            audio_bytes.len(),
            content_type
        ));

        if is_websocket_endpoint(&self.config.endpoint) {
            self.sync_via_websocket(audio_bytes, &content_type).await
        } else {
            self.sync_via_http_upload(
                audio_bytes,
                &content_type,
                plain_lyrics,
                track_urn,
                artist,
                title,
            )
            .await
        }
    }

    async fn sync_via_http_upload(
        &self,
        audio_bytes: Vec<u8>,
        content_type: &str,
        plain_lyrics: String,
        track_urn: Option<String>,
        artist: Option<String>,
        title: Option<String>,
    ) -> Result<Value, String> {
        let file_name = format!(
            "{}.{}",
            sanitize_file_name(track_urn.as_deref().unwrap_or("track")),
            extension_from_mime(content_type)
        );

        let mut form = Form::new()
            .part(
                "audio",
                Part::bytes(audio_bytes)
                    .file_name(file_name)
                    .mime_str(content_type)
                    .map_err(|err| format!("Invalid audio MIME type: {err}"))?,
            )
            .text("lyrics", plain_lyrics.clone())
            .text("plainLyrics", plain_lyrics);

        if let Some(track_urn) = track_urn.filter(|value| !value.trim().is_empty()) {
            form = form.text("trackUrn", track_urn);
        }
        if let Some(artist) = artist.filter(|value| !value.trim().is_empty()) {
            form = form.text("artist", artist);
        }
        if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
            form = form.text("title", title);
        }

        let mut request = self.http_client.post(&self.config.endpoint).multipart(form);
        if !self.config.api_key.is_empty() {
            request = request
                .bearer_auth(&self.config.api_key)
                .header("x-api-key", &self.config.api_key);
        }

        let response = request.send().await.map_err(|err| {
            let message = format!("Vosk endpoint request failed: {err}");
            debug_warn(&message);
            message
        })?;

        let response_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let body_suffix = if body.trim().is_empty() {
                String::new()
            } else {
                format!(" {body}")
            };
            let message = format!("Vosk endpoint returned {status}{body_suffix}");
            debug_warn(&message);
            return Err(message);
        }

        if response_type.contains("application/json") {
            debug_log("Vosk HTTP endpoint returned JSON payload");
            return response.json::<Value>().await.map_err(|err| {
                let message = format!("Failed to parse Vosk JSON: {err}");
                debug_warn(&message);
                message
            });
        }

        debug_log(format!(
            "Vosk HTTP endpoint returned text payload: content_type={response_type}"
        ));
        response.text().await.map(Value::String).map_err(|err| {
            let message = format!("Failed to read Vosk response: {err}");
            debug_warn(&message);
            message
        })
    }

    async fn sync_via_websocket(
        &self,
        audio_bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<Value, String> {
        let pcm = decode_audio_to_pcm16k_mono(&audio_bytes, content_type)?;
        debug_log(format!(
            "decoded audio for websocket: pcm_bytes={}, sample_rate={}, channels=1",
            pcm.len(),
            TARGET_SAMPLE_RATE
        ));

        let mut socket = self.connect_vosk_websocket().await?;

        socket
            .send(Message::Text(format!(
                "{{ \"config\" : {{ \"sample_rate\" : {}, \"words\" : 1 }} }}",
                TARGET_SAMPLE_RATE
            )))
            .await
            .map_err(|err| {
                let message = format!("Failed to send Vosk websocket config: {err}");
                debug_warn(&message);
                message
            })?;

        let chunk_size = (TARGET_SAMPLE_RATE as usize * 2 * WS_CHUNK_MILLIS) / 1000;
        let mut last_payload = Value::Null;

        for chunk in pcm.chunks(chunk_size.max(1024)) {
            socket
                .send(Message::Binary(chunk.to_vec()))
                .await
                .map_err(|err| {
                    let message = format!("Failed to stream PCM to Vosk websocket: {err}");
                    debug_warn(&message);
                    message
                })?;

            if let Some(payload) = read_next_vosk_message(&mut socket).await? {
                last_payload = payload;
            }
        }

        socket
            .send(Message::Text("{\"eof\" : 1}".to_string()))
            .await
            .map_err(|err| {
                let message = format!("Failed to send Vosk websocket EOF: {err}");
                debug_warn(&message);
                message
            })?;

        while let Some(payload) = read_next_vosk_message(&mut socket).await? {
            let has_final = payload.get("result").is_some() || payload.get("text").is_some();
            last_payload = payload;
            if has_final {
                break;
            }
        }

        let _ = close_socket_gracefully(&mut socket).await;

        if last_payload.is_null() {
            let message = "Vosk websocket returned no payload".to_string();
            debug_warn(&message);
            return Err(message);
        }

        debug_log("Vosk websocket sync success");
        Ok(last_payload)
    }

    async fn ensure_ready(&self) -> Result<(), String> {
        if self.endpoint_reachable().await {
            debug_log(format!("endpoint already reachable: {}", self.config.endpoint));
            return Ok(());
        }

        if !self.config.autostart {
            debug_warn("endpoint is down and autostart is disabled");
            return Err("Vosk endpoint is not reachable and autostart is disabled".into());
        }

        debug_log("endpoint is down, trying to spawn sidecar");
        self.spawn_sidecar_if_needed()?;

        let timeout_at = std::time::Instant::now() + Duration::from_millis(self.config.ready_timeout_ms);
        while std::time::Instant::now() < timeout_at {
            if self.endpoint_reachable().await {
                debug_log(format!("endpoint became ready: {}", self.config.endpoint));
                return Ok(());
            }
            if !self.is_child_alive() {
                let message = "Vosk sidecar exited before endpoint became ready".to_string();
                debug_warn(&message);
                return Err(message);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        let message = format!(
            "Vosk sidecar did not become ready within {} ms",
            self.config.ready_timeout_ms
        );
        debug_warn(&message);
        Err(message)
    }

    async fn endpoint_reachable(&self) -> bool {
        if is_websocket_endpoint(&self.config.endpoint) {
            return self.websocket_ready().await;
        }

        let Ok(url) = Url::parse(&self.config.endpoint) else {
            return false;
        };

        let Some(host) = url.host_str() else {
            return false;
        };
        let port = url.port_or_known_default().unwrap_or_else(|| {
            if is_websocket_endpoint(&self.config.endpoint) {
                2700
            } else {
                80
            }
        });

        tokio::time::timeout(
            Duration::from_millis(600),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .is_some()
    }

    async fn websocket_ready(&self) -> bool {
        match tokio::time::timeout(
            Duration::from_millis(1500),
            connect_async(&self.config.endpoint),
        )
        .await
        {
            Ok(Ok((mut socket, _))) => {
                let config_message = Message::Text(format!(
                    "{{ \"config\" : {{ \"sample_rate\" : {}, \"words\" : 1 }} }}",
                    TARGET_SAMPLE_RATE
                ));
                if socket.send(config_message).await.is_err() {
                    let _ = close_socket_gracefully(&mut socket).await;
                    return false;
                }
                if socket.send(Message::Text("{\"eof\" : 1}".to_string())).await.is_err() {
                    let _ = close_socket_gracefully(&mut socket).await;
                    return false;
                }
                let ready = read_next_vosk_message(&mut socket).await.ok().flatten().is_some();
                let _ = close_socket_gracefully(&mut socket).await;
                ready
            }
            Ok(Err(err)) => {
                debug_log(format!("websocket not ready yet: {err}"));
                false
            }
            Err(_) => false,
        }
    }

    async fn connect_vosk_websocket(
        &self,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        String,
    > {
        let timeout_at = std::time::Instant::now() + Duration::from_secs(20);
        let mut last_error = String::from("unknown websocket error");

        while std::time::Instant::now() < timeout_at {
            match connect_async(&self.config.endpoint).await {
                Ok((socket, _)) => return Ok(socket),
                Err(err) => {
                    last_error = err.to_string();
                    debug_log(format!("waiting for websocket handshake: {last_error}"));
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }

        let message = format!("Failed to connect to Vosk websocket: {last_error}");
        debug_warn(&message);
        Err(message)
    }

    fn spawn_sidecar_if_needed(&self) -> Result<(), String> {
        if self.is_child_alive() {
            debug_log("sidecar already running");
            return Ok(());
        }

        let Some(command) = self.config.command.as_deref() else {
            debug_warn("autostart requested without configured command");
            return Err("Vosk autostart is enabled, but no Vosk command was configured".into());
        };

        let mut child_lock = self
            .child
            .lock()
            .map_err(|_| "Failed to lock Vosk child process state".to_string())?;

        if let Some(child) = child_lock.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => {
                    *child_lock = None;
                }
            }
        }

        let mut cmd = Command::new(command);
        cmd.args(&self.config.args)
            .stdin(Stdio::null());

        #[cfg(debug_assertions)]
        {
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        }

        #[cfg(not(debug_assertions))]
        {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }

        if let Some(cwd) = self.config.cwd.as_deref() {
            cmd.current_dir(cwd);
        }

        debug_log(format!(
            "spawning sidecar: command={}, args={:?}, cwd={:?}",
            command, self.config.args, self.config.cwd
        ));
        let child = cmd.spawn().map_err(|err| {
            let message = format!("Failed to launch Vosk sidecar `{command}`: {err}");
            debug_warn(&message);
            message
        })?;

        #[cfg(debug_assertions)]
        let mut child = child;

        #[cfg(debug_assertions)]
        {
            if let Some(stdout) = child.stdout.take() {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        match line {
                            Ok(line) if !line.trim().is_empty() => println!("[Vosk:stdout] {line}"),
                            Ok(_) => {}
                            Err(err) => {
                                eprintln!("[Vosk] failed reading sidecar stdout: {err}");
                                break;
                            }
                        }
                    }
                });
            }

            if let Some(stderr) = child.stderr.take() {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        match line {
                            Ok(line) if !line.trim().is_empty() => eprintln!("[Vosk:stderr] {line}"),
                            Ok(_) => {}
                            Err(err) => {
                                eprintln!("[Vosk] failed reading sidecar stderr: {err}");
                                break;
                            }
                        }
                    }
                });
            }
        }

        *child_lock = Some(child);
        if let Ok(mut launched) = self.launched_by_app.lock() {
            *launched = true;
        }
        debug_log("sidecar process spawned");
        Ok(())
    }

    fn is_child_alive(&self) -> bool {
        let Ok(mut child_lock) = self.child.lock() else {
            return false;
        };

        let Some(child) = child_lock.as_mut() else {
            return false;
        };

        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) | Err(_) => {
                *child_lock = None;
                false
            }
        }
    }
}

#[tauri::command]
pub fn get_vosk_status(state: tauri::State<'_, Arc<VoskState>>) -> VoskStatus {
    state.status_snapshot()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn vosk_sync_lyrics(
    state: tauri::State<'_, Arc<VoskState>>,
    stream_url: String,
    plain_lyrics: String,
    track_urn: Option<String>,
    artist: Option<String>,
    title: Option<String>,
) -> Result<Value, String> {
    state
        .sync_from_stream_url(stream_url, plain_lyrics, track_urn, artist, title)
        .await
}

fn load_vosk_config(app: &tauri::AppHandle) -> VoskConfig {
    let env_map = collect_env_sources(app);
    let endpoint = env_map
        .get("VITE_LYRICS_VOSK_URL")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_VOSK_URL.to_string());
    let enabled = parse_bool_env(env_map.get("VITE_LYRICS_VOSK_ASR"));
    let autostart = env_map
        .get("VITE_LYRICS_VOSK_AUTOSTART")
        .map(|value| parse_bool_env(Some(value)))
        .unwrap_or(enabled);
    let command = env_map
        .get("VITE_LYRICS_VOSK_COMMAND")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| default_vosk_command(app, &endpoint));
    let args = env_map
        .get("VITE_LYRICS_VOSK_ARGS")
        .map(|value| parse_args_env(Some(value)))
        .filter(|args| !args.is_empty())
        .unwrap_or_else(|| default_vosk_args(&endpoint));
    let cwd = env_map
        .get("VITE_LYRICS_VOSK_CWD")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let ready_timeout_ms = env_map
        .get("VITE_LYRICS_VOSK_READY_TIMEOUT_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1000)
        .unwrap_or_else(|| default_ready_timeout_ms(&endpoint, command.as_deref()));
    let api_key = env_map
        .get("VITE_LYRICS_VOSK_KEY")
        .cloned()
        .unwrap_or_default();

    VoskConfig {
        enabled,
        autostart,
        endpoint,
        command,
        args,
        cwd,
        ready_timeout_ms,
        api_key,
    }
}

fn collect_env_sources(app: &tauri::AppHandle) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (key, value) in std::env::vars() {
        result.insert(key, value);
    }

    for path in candidate_env_paths(app) {
        merge_env_file(&mut result, &path);
    }

    result
}

fn candidate_env_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    if let Some(desktop_dir) = manifest_dir.parent() {
        paths.push(desktop_dir.join(".env"));
        paths.push(desktop_dir.join(".env.local"));
    }

    if let Ok(config_dir) = app.path().app_data_dir() {
        paths.push(config_dir.join("vosk.env"));
    }

    paths
}

fn merge_env_file(target: &mut HashMap<String, String>, path: &Path) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };

        target.insert(key.trim().to_string(), strip_matching_quotes(value.trim()));
    }
}

fn strip_matching_quotes(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.chars().next().unwrap_or_default();
        let last = value.chars().last().unwrap_or_default();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return value[1..value.len() - 1].to_string();
        }
    }

    value.to_string()
}

fn parse_bool_env(value: Option<&String>) -> bool {
    value
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn parse_args_env(value: Option<&String>) -> Vec<String> {
    let Some(raw) = value.map(|value| value.trim()).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };

    if raw.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(raw) {
            return parsed;
        }
    }

    raw.split_whitespace().map(ToString::to_string).collect()
}

fn default_vosk_command(app: &tauri::AppHandle, endpoint: &str) -> Option<String> {
    if is_websocket_endpoint(endpoint) {
        return Some("docker".to_string());
    }

    #[cfg(target_os = "windows")]
    let binary_name = "vosk-server.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "vosk-server";

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = vec![manifest_dir.join("bin").join(binary_name)];

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(binary_name));
    }
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        candidates.push(app_data_dir.join("vosk").join(binary_name));
    }

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    Some(binary_name.to_string())
}

fn default_vosk_args(endpoint: &str) -> Vec<String> {
    if !is_websocket_endpoint(endpoint) {
        return Vec::new();
    }

    let port = Url::parse(endpoint)
        .ok()
        .and_then(|url| url.port_or_known_default())
        .unwrap_or(2700);

    vec![
        "run".to_string(),
        "--rm".to_string(),
        "-p".to_string(),
        format!("{port}:2700"),
        "alphacep/kaldi-ru:latest".to_string(),
    ]
}

fn default_ready_timeout_ms(endpoint: &str, command: Option<&str>) -> u64 {
    if is_websocket_endpoint(endpoint)
        && command
            .map(|value| value.eq_ignore_ascii_case("docker") || value.ends_with("docker.exe"))
            .unwrap_or(false)
    {
        return DEFAULT_DOCKER_VOSK_READY_TIMEOUT_MS;
    }

    DEFAULT_VOSK_READY_TIMEOUT_MS
}

fn is_websocket_endpoint(endpoint: &str) -> bool {
    endpoint.starts_with("ws://") || endpoint.starts_with("wss://")
}

async fn read_response_bytes_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("Failed to read audio stream: {err}"))?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() > max_bytes {
            return Err("Audio stream is too large for Vosk upload".into());
        }
    }

    Ok(bytes)
}

async fn close_socket_gracefully(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "".into(),
        })))
        .await?;
    socket.close(None).await
}

async fn read_next_vosk_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<Option<Value>, String> {
    let Some(message) = socket.next().await else {
        return Ok(None);
    };

    let message = message.map_err(|err| format!("Failed to read Vosk websocket message: {err}"))?;
    match message {
        Message::Text(text) => serde_json::from_str::<Value>(&text)
            .map(Some)
            .map_err(|err| format!("Invalid Vosk websocket JSON: {err}")),
        Message::Binary(_) => Ok(None),
        Message::Close(_) => Ok(None),
        Message::Ping(_) | Message::Pong(_) => Ok(None),
        Message::Frame(_) => Ok(None),
    }
}

fn decode_audio_to_pcm16k_mono(audio_bytes: &[u8], content_type: &str) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(audio_bytes.to_vec());
    let stream = MediaSourceStream::new(Box::new(cursor), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = extension_hint_from_mime(content_type) {
        hint.with_extension(ext);
    }

    let probed = get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|err| format!("Failed to probe audio stream for Vosk: {err}"))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| "No decodable audio track found for Vosk".to_string())?;

    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|err| format!("Failed to create audio decoder for Vosk: {err}"))?;

    let mut mono_samples = Vec::<f32>::new();
    let mut source_sample_rate = track.codec_params.sample_rate.unwrap_or(TARGET_SAMPLE_RATE);

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("Audio decoder reset is not supported for Vosk sync".into())
            }
            Err(err) => return Err(format!("Failed to read audio packet for Vosk: {err}")),
        };

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err("Audio decoder reset is not supported for Vosk sync".into())
            }
            Err(err) => return Err(format!("Failed to decode audio for Vosk: {err}")),
        };

        let spec = *decoded.spec();
        source_sample_rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buffer.copy_interleaved_ref(decoded);

        for frame in sample_buffer.samples().chunks(channels) {
            let mixed = frame.iter().copied().sum::<f32>() / channels as f32;
            mono_samples.push(mixed);
        }
    }

    if mono_samples.is_empty() {
        return Err("Decoded audio is empty for Vosk sync".into());
    }

    let resampled = if source_sample_rate == TARGET_SAMPLE_RATE {
        mono_samples
    } else {
        linear_resample_mono(&mono_samples, source_sample_rate, TARGET_SAMPLE_RATE)
    };

    Ok(float_samples_to_pcm16le(&resampled))
}

fn linear_resample_mono(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if samples.is_empty() || from_rate == 0 || from_rate == to_rate {
        return samples.to_vec();
    }

    let target_len = ((samples.len() as f64) * (to_rate as f64) / (from_rate as f64)).round() as usize;
    let mut output = Vec::with_capacity(target_len.max(1));

    for index in 0..target_len {
        let position = (index as f64) * (from_rate as f64) / (to_rate as f64);
        let left = position.floor() as usize;
        let right = (left + 1).min(samples.len().saturating_sub(1));
        let frac = (position - left as f64) as f32;
        let left_sample = samples[left];
        let right_sample = samples[right];
        output.push(left_sample + (right_sample - left_sample) * frac);
    }

    output
}

fn float_samples_to_pcm16le(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let pcm = (clamped * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&pcm.to_le_bytes());
    }
    bytes
}

fn extension_hint_from_mime(mime: &str) -> Option<&'static str> {
    if mime.contains("mpeg") {
        Some("mp3")
    } else if mime.contains("mp4") || mime.contains("aac") {
        Some("m4a")
    } else if mime.contains("ogg") {
        Some("ogg")
    } else if mime.contains("wav") {
        Some("wav")
    } else {
        None
    }
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "track".to_string()
    } else {
        trimmed.to_string()
    }
}

fn extension_from_mime(mime: &str) -> &'static str {
    if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("mp4") || mime.contains("aac") {
        "m4a"
    } else if mime.contains("wav") {
        "wav"
    } else {
        "mp3"
    }
}
