mod audio_player;
mod constants;
mod discord;
mod hls;
mod image_cache;
mod media_proxy;
mod proxy;
mod proxy_server;
mod server;
mod soundcloud_api;
mod spotify_import;
mod static_server;
mod track_cache;
mod tray;
mod ym_import;
mod ytmusic_import;

use base64::Engine;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{window::Color, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use discord::DiscordState;
use server::ServerState;

/// Switch the main window icon AND the tray icon to one of the bundled
/// variants. PNGs are baked into the binary at compile time via
/// `include_image!`, so no filesystem I/O happens at runtime — instant
/// switch. Works cross-platform: Tauri's `Window::set_icon` and
/// `TrayIcon::set_icon` abstract over Win/Linux/macOS, and bundled bytes
/// survive sandboxing (Flatpak/AppImage/MSIX) since nothing is read from
/// disk at runtime.
///
/// Per-platform notes:
/// - Windows: titlebar + taskbar + tray, all swap immediately.
/// - Linux X11/Wayland: window icon via _NET_WM_ICON, tray via
///   StatusNotifier/XEmbed (provided by xdg-desktop-portal in Flatpak).
/// - macOS: window-level icon is a no-op (Cocoa uses the .icns bundle),
///   but the menu-bar tray icon still updates.
#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, variant: String) -> Result<(), String> {
    // Window icon: large source so Windows can scale it for titlebar (16),
    // alt-tab (32) and taskbar (32-48) with its own downscaler.
    let win_img = match variant.as_str() {
        "inverted" => tauri::include_image!("icons/variants/inverted.png"),
        "upstream" => tauri::include_image!("icons/variants/upstream.png"),
        "wave" => tauri::include_image!("icons/variants/wave.png"),
        _ => tauri::include_image!("icons/variants/default.png"),
    };
    // Tray icon: pre-rendered 64x64 with high-quality LANCZOS downscaling.
    // Windows tray rendering at 16/20/24/32 (DPI-dependent) with a 256x256
    // source produced a muddy, pixelated icon — going through a 64x64
    // intermediate gives much sharper results because Windows' built-in
    // downscaler is closer to nearest-neighbor than to bicubic.
    let tray_img = match variant.as_str() {
        "inverted" => tauri::include_image!("icons/variants/inverted-tray.png"),
        "upstream" => tauri::include_image!("icons/variants/upstream-tray.png"),
        "wave" => tauri::include_image!("icons/variants/wave-tray.png"),
        _ => tauri::include_image!("icons/variants/default-tray.png"),
    };
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(win_img).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(tray_img)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Apply a user-supplied PNG/ICO from disk as the window + tray icon.
/// Loaded at runtime via `Image::from_path`, so the file must remain on
/// disk for the lifetime of the app (we don't copy it here — the frontend
/// calls `copy_custom_app_icon` first and then passes the in-app-data path).
#[tauri::command]
fn set_custom_app_icon(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let img = tauri::image::Image::from_path(&path).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(img.clone()).map_err(|e| e.to_string())?;
    }
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(img)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy the user-picked image into `<app_data>/custom-icons/user-<ts>.<ext>`
/// and return the new path. We do this in Rust so the frontend doesn't need
/// plugin-fs permissions for arbitrary source locations (the dialog can
/// return any path on disk; capabilities only allow appdata scope).
#[tauri::command]
fn copy_custom_app_icon(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("custom-icons");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&src)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("user-{}.{}", ts, ext));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/* ── Fonts ──────────────────────────────────────────────── */

#[derive(serde::Serialize, Clone)]
struct SystemFont {
    family: String,
    path: String,
}

/// Pull the English (or fallback) `family name` out of a TTF/OTF/TTC.
/// Returns `None` if the file isn't a parseable font or has no family entry.
fn read_family_name(path: &std::path::Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    // TTC (collections) wrap multiple faces; index 0 is fine for picker UI —
    // weights/styles inside the same family share the family name anyway.
    let face = ttf_parser::Face::parse(&data, 0).ok()?;
    let mut english: Option<String> = None;
    let mut fallback: Option<String> = None;
    for name in face.names() {
        if name.name_id != ttf_parser::name_id::FAMILY {
            continue;
        }
        if let Some(s) = name.to_string() {
            // Prefer Mac/Windows English entries; otherwise take whatever we find.
            let is_english = matches!(
                (name.platform_id, name.language_id),
                (ttf_parser::PlatformId::Windows, 0x0409)
                    | (ttf_parser::PlatformId::Macintosh, 0)
                    | (ttf_parser::PlatformId::Unicode, _)
            );
            if is_english && english.is_none() {
                english = Some(s);
            } else if fallback.is_none() {
                fallback = Some(s);
            }
        }
    }
    english.or(fallback)
}

fn system_font_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(win) = std::env::var("WINDIR") {
            dirs.push(std::path::PathBuf::from(win).join("Fonts"));
        } else {
            dirs.push(std::path::PathBuf::from(r"C:\Windows\Fonts"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                std::path::PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(std::path::PathBuf::from("/System/Library/Fonts"));
        dirs.push(std::path::PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
            dirs.push(home.join("Library/Fonts"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(std::path::PathBuf::from("/usr/share/fonts"));
        dirs.push(std::path::PathBuf::from("/usr/local/share/fonts"));
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
            dirs.push(home.join(".fonts"));
            dirs.push(home.join(".local/share/fonts"));
        }
    }
    dirs
}

/// Cached list of system fonts. Populated lazily on first call — scanning
/// can take 100ms-2s on machines with thousands of fonts. We only refresh
/// when the user explicitly invokes `refresh_system_fonts`.
static SYSTEM_FONTS_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<Vec<SystemFont>>>> =
    std::sync::OnceLock::new();

fn scan_system_fonts() -> Vec<SystemFont> {
    use std::collections::HashMap;
    let mut by_family: HashMap<String, SystemFont> = HashMap::new();
    for dir in system_font_dirs() {
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "otc") {
                continue;
            }
            if let Some(family) = read_family_name(path) {
                // First face for a family wins — we don't need every weight.
                by_family.entry(family.clone()).or_insert(SystemFont {
                    family,
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
    }
    let mut list: Vec<SystemFont> = by_family.into_values().collect();
    list.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
    list
}

#[tauri::command]
fn list_system_fonts() -> Vec<SystemFont> {
    let cache = SYSTEM_FONTS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    {
        let guard = cache.lock().unwrap();
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }
    let list = scan_system_fonts();
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(list.clone());
    }
    list
}

#[tauri::command]
fn refresh_system_fonts() -> Vec<SystemFont> {
    let list = scan_system_fonts();
    let cache = SYSTEM_FONTS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(list.clone());
    }
    list
}

/// Read a font file and return its parsed family name. The frontend uses
/// this both for system fonts (rendering each option in its own family) and
/// for newly-imported custom fonts (so the @font-face rule uses the right
/// canonical name in the picker preview).
#[tauri::command]
fn read_font_family(path: String) -> Result<String, String> {
    read_family_name(std::path::Path::new(&path))
        .ok_or_else(|| "Could not parse font family name".to_string())
}

/// Copy a user-picked font into `<app_data>/fonts/`. Same rationale as
/// `copy_custom_app_icon` — frontend can't read arbitrary disk paths under
/// our plugin-fs scope, so we do the copy in std::fs.
#[tauri::command]
fn copy_custom_font(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("fonts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&src)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("ttf")
        .to_lowercase();
    if !matches!(ext.as_str(), "ttf" | "otf" | "woff" | "woff2") {
        return Err(format!("Unsupported font format: {}", ext));
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("user-{}.{}", ts, ext));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

const FPS_PRESETS: [u32; 4] = [15, 30, 60, 120];

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct FramerateConfig {
    target: u32,
    unlocked: bool,
}

fn normalize_target_framerate(target: u32) -> u32 {
    let mut closest = FPS_PRESETS[0];
    let mut min_distance = target.abs_diff(closest);

    for preset in FPS_PRESETS.iter().skip(1) {
        let distance = target.abs_diff(*preset);
        if distance < min_distance {
            closest = *preset;
            min_distance = distance;
        }
    }

    closest
}

fn normalize_framerate_config(target: u32, _unlocked: bool) -> FramerateConfig {
    FramerateConfig {
        target: normalize_target_framerate(target),
        unlocked: false,
    }
}

#[tauri::command]
fn save_framerate_config(app: tauri::AppHandle, target: u32, unlocked: bool) {
    let config = normalize_framerate_config(target, unlocked);
    if let Ok(config_dir) = app.path().app_data_dir() {
        std::fs::create_dir_all(&config_dir).ok();
        let config_path = config_dir.join("framerate_config.json");
        if let Ok(json) = serde_json::to_string(&config) {
            std::fs::write(&config_path, json).ok();
        }
    }
    let state = app.state::<audio_player::AudioState>();
    audio_player::set_framerate_config(&state, config.target, config.unlocked);
}

#[derive(serde::Serialize)]
struct ExternalHttpResponse {
    status: u16,
    content_type: String,
    body: String,
}

#[tauri::command]
async fn external_http_get(url: String, accept: Option<String>) -> Result<ExternalHttpResponse, String> {
    let parsed_url = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("Unsupported URL scheme".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(6500))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(parsed_url);
    if let Some(accept) = accept.filter(|value| !value.trim().is_empty()) {
        request = request.header(reqwest::header::ACCEPT, accept);
    }
    request = request
        .header(
            reqwest::header::ACCEPT_LANGUAGE,
            "en-US,en;q=0.8,ru;q=0.7",
        )
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        );

    if let Some(host) = request
        .try_clone()
        .and_then(|req| req.build().ok())
        .and_then(|req| req.url().host_str().map(str::to_owned))
    {
        if host.contains("music.yandex.") {
            request = request
                .header(reqwest::header::REFERER, "https://music.yandex.ru/")
                .header(reqwest::header::ORIGIN, "https://music.yandex.ru");
        }
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = response.text().await.map_err(|e| e.to_string())?;

    Ok(ExternalHttpResponse {
        status,
        content_type,
        body,
    })
}

fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .collect();

    let compact = sanitized
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let trimmed = compact.trim_matches(|ch: char| matches!(ch, '.' | ' '));
    if trimmed.is_empty() {
        "soundcloud-image".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_image_extension(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "webp" => Some("webp"),
        _ => None,
    }
}

fn image_extension_from_content_type(content_type: &str) -> Option<&'static str> {
    let mime = content_type.split(';').next()?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn image_extension_from_path(path: &Path) -> Option<&'static str> {
    path.extension()
        .and_then(|value| value.to_str())
        .and_then(normalize_image_extension)
}

fn image_extension_from_data_url(url: &str) -> Option<&'static str> {
    let header = url
        .strip_prefix("data:")?
        .split(',')
        .next()?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();

    match header.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn decode_scproxy_target_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "scproxy" {
        return None;
    }

    let encoded = parsed
        .path()
        .strip_prefix("/img/")?
        .trim();
    if encoded.is_empty() {
        return None;
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let payload = String::from_utf8(decoded).ok()?;
    let urls = serde_json::from_str::<Vec<String>>(&payload).ok()?;
    urls.into_iter().next().filter(|value| !value.trim().is_empty())
}

fn decode_data_url_image(url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let payload = url
        .strip_prefix("data:")
        .ok_or_else(|| "Unsupported image URL".to_string())?;
    let (meta, data) = payload
        .split_once(',')
        .ok_or_else(|| "Invalid data URL".to_string())?;
    let extension = image_extension_from_data_url(url)
        .ok_or_else(|| "Unsupported data URL image format".to_string())?;

    if meta.contains(";base64") {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        return Ok((decoded, extension));
    }

    let decoded = urlencoding::decode(data)
        .map_err(|e| e.to_string())?
        .into_owned()
        .into_bytes();
    Ok((decoded, extension))
}

fn resolve_downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = app.path().download_dir() {
        return Ok(path);
    }

    if let Ok(home_dir) = app.path().home_dir() {
        return Ok(home_dir.join("Downloads"));
    }

    Err("Failed to resolve Downloads directory".to_string())
}

fn next_available_download_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let mut index = 0u32;

    loop {
        let file_name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = dir.join(file_name);

        if !candidate.exists() {
            return candidate;
        }

        index += 1;
    }
}

#[tauri::command]
async fn save_image_to_downloads(
    app: tauri::AppHandle,
    url: String,
    suggested_name: Option<String>,
) -> Result<String, String> {
    let url = decode_scproxy_target_url(&url).unwrap_or(url);
    let data_url_result = if url.starts_with("data:") {
        Some(decode_data_url_image(&url)?)
    } else {
        None
    };

    let parsed_url = if data_url_result.is_none() {
        Some(reqwest::Url::parse(&url).map_err(|e| e.to_string())?)
    } else {
        None
    };
    if parsed_url
        .as_ref()
        .is_some_and(|parsed_url| !matches!(parsed_url.scheme(), "http" | "https"))
    {
        return Err("Unsupported image URL".to_string());
    }

    let suggested_name = suggested_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("soundcloud-image");
    let suggested_path = Path::new(suggested_name);
    let stem_source = suggested_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("soundcloud-image");
    let stem = sanitize_filename_component(stem_source);
    let (bytes, extension) = if let Some((bytes, extension)) = data_url_result {
        (bytes, extension)
    } else {
        let parsed_url = parsed_url
            .as_ref()
            .ok_or_else(|| "Unsupported image URL".to_string())?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(12000))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| e.to_string())?;

        let mut request = client.get(parsed_url.clone());
        request = request
            .header(
                reqwest::header::ACCEPT,
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            )
            .header(
                reqwest::header::ACCEPT_LANGUAGE,
                "en-US,en;q=0.8,ru;q=0.7",
            )
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            );

        if let Some(host) = parsed_url.host_str() {
            if host.contains("music.yandex.") {
                request = request
                    .header(reqwest::header::REFERER, "https://music.yandex.ru/")
                    .header(reqwest::header::ORIGIN, "https://music.yandex.ru");
            } else if host.contains("sndcdn.com") || host.contains("soundcloud.com") {
                request = request
                    .header(reqwest::header::REFERER, "https://soundcloud.com/")
                    .header(reqwest::header::ORIGIN, "https://soundcloud.com");
            }
        }

        let response = request.send().await.map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("Image download failed: {}", response.status()));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();

        if !content_type.is_empty() && !content_type.to_ascii_lowercase().starts_with("image/") {
            return Err("URL did not return an image".to_string());
        }

        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return Err("Downloaded image is empty".to_string());
        }

        let extension = image_extension_from_content_type(&content_type)
            .or_else(|| image_extension_from_path(suggested_path))
            .or_else(|| image_extension_from_path(Path::new(parsed_url.path())))
            .unwrap_or("jpg");

        (bytes.to_vec(), extension)
    };

    let downloads_dir = resolve_downloads_dir(&app)?;
    fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?;

    let destination = next_available_download_path(&downloads_dir, &stem, extension);
    tokio::fs::write(&destination, &bytes)
        .await
        .map_err(|e| e.to_string())?;

    Ok(destination.to_string_lossy().into_owned())
}

pub(crate) fn emit_window_visibility(app: &tauri::AppHandle, visible: bool) {
    let state = app.state::<audio_player::AudioState>();
    state.window_visible.store(visible, Ordering::Relaxed);
    let _ = app.emit("app:window-visibility", visible);
}

fn append_bootstrap_error_log(message: &str) {
    let base_dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from));
    let Some(base_dir) = base_dir else {
        eprintln!("{message}");
        return;
    };

    let logs_dir = base_dir.join("com.soundcloud.desktop").join("logs");
    if fs::create_dir_all(&logs_dir).is_err() {
        eprintln!("{message}");
        return;
    }

    let log_path = logs_dir.join("startup-error.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{message}");
    } else {
        eprintln!("{message}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    let result = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
                emit_window_visibility(app, true);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("scproxy", |_ctx, request, responder| {
            let Some(state) = proxy::STATE.get() else {
                responder.respond(
                    http::Response::builder()
                        .status(503)
                        .body(b"not ready".to_vec())
                        .unwrap(),
                );
                return;
            };
            state.rt_handle.spawn(async move {
                responder.respond(proxy::handle_uri(request).await);
            });
        })
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let cache_dir = app
                .path()
                .app_cache_dir()
                .expect("failed to resolve app cache dir");

            let config_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&config_dir).ok();

            app.manage(soundcloud_api::OAuthCallbackState::default());
            soundcloud_api::init_deep_link(&app.handle()).map_err(std::io::Error::other)?;

            // Read framerate config
            let config_path = config_dir.join("framerate_config.json");
            #[allow(unused)]
            let FramerateConfig { target, unlocked } = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|data| serde_json::from_str::<FramerateConfig>(&data).ok())
                .map(|cfg| normalize_framerate_config(cfg.target, cfg.unlocked))
                .unwrap_or_else(|| normalize_framerate_config(60, false));

            // Create main window dynamically
            #[allow(unused_mut)]
            let mut win_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("SoundCloud Desktop")
                    .inner_size(1300.0, 820.0)
                    .min_inner_size(1300.0, 820.0)
                    .background_color(Color(17, 18, 20, 255))
                    .decorations(false);

            #[cfg(target_os = "windows")]
            {
                let mut args = String::new();
                if unlocked {
                    args.push_str("--disable-frame-rate-limit --disable-gpu-vsync");
                } else {
                    args.push_str(&format!("--limit-fps={}", target));
                }
                win_builder = win_builder.additional_browser_args(&args);
            }

            win_builder.build().expect("failed to build main window");

            let audio_dir = cache_dir.join("audio");
            std::fs::create_dir_all(&audio_dir).ok();

            // 7.1.0 port: dedicated dir for likes-cache so it survives normal
            // cache cleanup (the user opt-in to keep liked tracks offline and
            // would otherwise lose them on every clear-cache action).
            let liked_audio_dir = cache_dir.join("audio_liked");
            std::fs::create_dir_all(&liked_audio_dir).ok();

            let assets_dir = cache_dir.join("assets");
            std::fs::create_dir_all(&assets_dir).ok();

            let wallpapers_dir = cache_dir.join("wallpapers");
            std::fs::create_dir_all(&wallpapers_dir).ok();

            // 7.1.0 port: image cache lives in app_data_dir (NOT cache_dir) so
            // the OS doesn't reclaim it. Used by the proxy to memoize remote
            // covers permanently without re-fetching every cold start.
            let images_dir = config_dir.join("images");
            std::fs::create_dir_all(&images_dir).ok();

            let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");

            let shared_http_client = reqwest::Client::new();
            let media_proxy_state = media_proxy::init(app.handle().clone());

            proxy::STATE
                .set(proxy::State {
                    assets_dir,
                    http_client: shared_http_client.clone(),
                    rt_handle: rt.handle().clone(),
                })
                .ok();

            image_cache::STATE
                .set(image_cache::ImageCache {
                    dir: images_dir,
                    _http_client: shared_http_client,
                })
                .ok();

            let (static_port, proxy_port) =
                rt.block_on(server::start_all(wallpapers_dir, app.handle().clone()));

            std::thread::spawn(move || {
                rt.block_on(std::future::pending::<()>());
            });

            app.manage(Arc::new(ServerState {
                static_port,
                proxy_port,
            }));
            app.manage(Arc::new(DiscordState {
                client: Mutex::new(None),
            }));

            let audio_state = audio_player::init();
            audio_player::set_framerate_config(&audio_state, target, unlocked);
            app.manage(audio_state);
            app.manage(media_proxy_state);
            app.manage(spotify_import::SpotifyState::new());
            app.manage(ytmusic_import::YtMusicState::new());

            // 7.1.0 port: track cache state handles background API downloads
            // and likes preloading. Needs the app handle to emit progress
            // events back to the UI during background fills.
            let mut track_cache_state = track_cache::init(audio_dir, liked_audio_dir);
            track_cache_state.app_handle = Some(app.handle().clone());
            app.manage(track_cache_state);
            audio_player::start_tick_emitter(app.handle());
            audio_player::start_media_controls(app.handle());
            audio_player::start_visualizer_thread(app.handle());

            tray::setup_tray(app).expect("failed to setup tray");

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                emit_window_visibility(&window.app_handle(), false);
            }
        })
        .invoke_handler(tauri::generate_handler![
            server::get_server_ports,
            discord::discord_connect,
            discord::discord_disconnect,
            discord::discord_set_activity,
            discord::discord_clear_activity,
            audio_player::audio_load_file,
            audio_player::audio_load_url,
            audio_player::audio_play,
            audio_player::audio_pause,
            audio_player::audio_stop,
            audio_player::audio_begin_stream_reload,
            audio_player::audio_seek,
            audio_player::audio_set_volume,
            audio_player::audio_set_playback_rate,
            audio_player::audio_set_pitch,
            audio_player::audio_get_position,
            audio_player::audio_set_eq,
            audio_player::audio_set_normalization,
            audio_player::audio_is_playing,
            audio_player::audio_set_metadata,
            audio_player::audio_set_playback_state,
            audio_player::audio_set_media_position,
            audio_player::audio_list_devices,
            audio_player::audio_switch_device,
            audio_player::save_track_to_path,
            soundcloud_api::soundcloud_oauth_start,
            soundcloud_api::soundcloud_oauth_refresh,
            soundcloud_api::get_cdn_stream_url,
            soundcloud_api::resolve_soundcloud_track_stream,
            soundcloud_api::fetch_soundcloud_me,
            ym_import::ym_import_start,
            ym_import::ym_import_stop,
            spotify_import::spotify_auth_start,
            spotify_import::spotify_is_authed,
            spotify_import::spotify_logout,
            spotify_import::spotify_import_start,
            spotify_import::spotify_import_stop,
            ytmusic_import::ytmusic_auth_start,
            ytmusic_import::ytmusic_is_authed,
            ytmusic_import::ytmusic_logout,
            ytmusic_import::ytmusic_import_start,
            ytmusic_import::ytmusic_import_stop,
            save_framerate_config,
            set_app_icon,
            set_custom_app_icon,
            copy_custom_app_icon,
            list_system_fonts,
            refresh_system_fonts,
            read_font_family,
            copy_custom_font,
            external_http_get,
            save_image_to_downloads,
            media_proxy::media_proxy_apply_settings,
            media_proxy::media_proxy_get_status,
            media_proxy::media_proxy_refresh_auto,
            media_proxy::media_proxy_report_degraded,
            media_proxy::media_proxy_http_get,
            // 7.1.0 port: direct-from-SC track cache + permanent image cache.
            track_cache::track_ensure_cached,
            track_cache::track_is_cached,
            track_cache::track_get_cache_path,
            track_cache::track_get_cache_info,
            track_cache::track_preload,
            track_cache::track_cache_size,
            track_cache::track_liked_cache_size,
            track_cache::track_clear_cache,
            track_cache::track_clear_liked_cache,
            track_cache::track_list_cached,
            track_cache::track_enforce_cache_limit,
            track_cache::track_cache_likes,
            track_cache::track_cache_likes_running,
            track_cache::track_cancel_cache_likes,
            image_cache::image_cache_size,
            image_cache::image_cache_clear,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        let message = format!("SoundCloud Desktop failed to run: {error}");
        append_bootstrap_error_log(&message);
        eprintln!("{message}");
    }
}
