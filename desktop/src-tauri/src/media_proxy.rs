use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::stream::StreamExt;
use regex::Regex;
use reqwest::header::{
    HeaderName, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, RANGE, USER_AGENT,
};
use reqwest::{Client, Response, StatusCode};
use tauri::Emitter;
use tokio::{net::TcpStream, sync::RwLock};

const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE: &str = "en-US,en;q=0.8,ru;q=0.7";
const BELURK_SOURCE_PAGE: &str = "https://belurk.ru/free-proxy";
const BELURK_SOURCE_LABEL: &str = "belurk.ru";
const BELURK_API_URL: &str = "https://backend.belurk.ru/api/proxy/free/list";
const GOLOGIN_SOURCE_PAGE: &str = "https://gologin.com/ru/free-proxy/";
const GOLOGIN_SOURCE_LABEL: &str = "gologin.com";
const GOLOGIN_API_URL: &str = "https://geoxy.io/proxies";
const GOLOGIN_API_AUTH: &str = "BgPXfhUc8CAhK7wGOqzqz9m77j3sH7";
const GOLOGIN_FETCH_COUNT: usize = 200;
const TOPROXYLAB_SOURCE_PAGE: &str = "https://toproxylab.com/ru/spisok-besplatnyh-proksi-serverov";
const TOPROXYLAB_SOURCE_LABEL: &str = "toproxylab.com";
const TOPROXYLAB_AJAX_URL: &str = "https://toproxylab.com/wp-admin/admin-ajax.php";
const TOPROXYLAB_AJAX_ACTION: &str = "fpl_get_proxies";
const TOPROXYLAB_MAX_PAGES: usize = 5;
const TOPROXYLAB_PAGE_DELAY_MS: u64 = 250;
const AUTO_MAX_CANDIDATES: usize = 42;
const VALIDATION_MEDIA_RANGE_HEADER: &str = "bytes=0-65535";
const VALIDATION_MIN_MEDIA_BYTES: usize = 8 * 1024;
const VALIDATION_TARGET_MEDIA_BYTES: usize = 24 * 1024;
const VALIDATION_TCP_TIMEOUT_MS: u64 = 6500;
const VALIDATION_CONNECT_TIMEOUT_MS: u64 = 5500;
const VALIDATION_READ_TIMEOUT_SECS: u64 = 30;
const MSG_MANUAL_INVALID: &str = "settings.mediaProxyMessageManualInvalid";
const MSG_MANUAL_MISSING_HOST_PORT: &str = "settings.mediaProxyMessageManualMissingHostPort";
const MSG_AUTO_UNAVAILABLE: &str = "settings.mediaProxyMessageAutoUnavailable";
const MSG_MANUAL_FAILED: &str = "settings.mediaProxyMessageManualFailed";
const MSG_AUTO_NO_REPLACEMENT: &str = "settings.mediaProxyMessageNoReplacement";
const MSG_AUTO_FALLBACK_NOTICE: &str = "settings.mediaProxyNoticeAutoFallback";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaProxyMode {
    Off,
    Auto,
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaProxyType {
    Http,
    Https,
    Socks4,
    Socks5,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProxyRouting {
    Direct,
    Proxy,
}

#[derive(Clone, Copy, Debug)]
pub enum ClientProfile {
    Generic,
    Download,
    Storage,
    Validation,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct MediaProxySettingsPayload {
    pub mode: MediaProxyMode,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub last_known_working_proxy: Option<MediaProxySessionSnapshot>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct MediaProxySessionSnapshot {
    pub mode: MediaProxyMode,
    pub routing: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    pub proxy_type: MediaProxyType,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub throughput_kbps: Option<u64>,
    #[serde(default)]
    pub last_checked_at: Option<u64>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MediaProxyStatus {
    pub mode: MediaProxyMode,
    pub routing: String,
    pub state: String,
    pub proxy_type: Option<String>,
    pub endpoint: Option<String>,
    pub latency_ms: Option<u64>,
    pub throughput_kbps: Option<u64>,
    pub proxy_pool_size: usize,
    pub last_checked_at: Option<u64>,
    pub message: Option<String>,
    pub message_key: Option<String>,
    pub message_args: Option<HashMap<String, String>>,
    pub last_known_working_proxy: Option<MediaProxySessionSnapshot>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MediaHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

#[derive(Clone, Debug)]
pub struct MediaBytesResponse {
    pub status: u16,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug)]
struct ManualProxySettings {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    type_hint: Option<MediaProxyType>,
}

#[derive(Clone, Debug)]
struct MediaProxyConfig {
    mode: MediaProxyMode,
    manual: Option<ManualProxySettings>,
}

#[derive(Clone, Debug)]
struct ProxyCandidate {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    type_hint: Option<MediaProxyType>,
    source: &'static str,
}

#[derive(Clone, Debug)]
struct ValidatedProxy {
    candidate: ProxyCandidate,
    proxy_type: MediaProxyType,
    latency_ms: u64,
    throughput_kbps: u64,
    last_checked_at: u64,
}

#[derive(Clone, Debug)]
pub struct RoutingDecision {
    mode: MediaProxyMode,
    routing: ProxyRouting,
    proxy: Option<ValidatedProxy>,
}

impl RoutingDecision {
    pub fn build_client(&self, profile: ClientProfile) -> Result<Client, String> {
        build_http_client(profile, self.proxy.as_ref(), None)
    }
}

struct MediaProxyRuntime {
    config: MediaProxyConfig,
    routing: ProxyRouting,
    standby_proxy: Option<ValidatedProxy>,
    active_proxy: Option<ValidatedProxy>,
    blacklisted_endpoints: HashSet<String>,
    last_media_url: Option<String>,
    proxy_pool_size: usize,
    last_checked_at: Option<u64>,
    message: Option<String>,
    message_key: Option<String>,
    message_args: Option<HashMap<String, String>>,
}

enum AutoPoolRefreshResult {
    Selected(ValidatedProxy),
    None,
    Cancelled,
}

pub struct MediaProxyState {
    app: tauri::AppHandle,
    auto_scan_epoch: AtomicU64,
    inner: RwLock<MediaProxyRuntime>,
}

pub static STATE: OnceLock<Arc<MediaProxyState>> = OnceLock::new();

impl MediaProxyState {
    fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            auto_scan_epoch: AtomicU64::new(0),
            inner: RwLock::new(MediaProxyRuntime {
                config: MediaProxyConfig {
                    mode: MediaProxyMode::Off,
                    manual: None,
                },
                routing: ProxyRouting::Direct,
                standby_proxy: None,
                active_proxy: None,
                blacklisted_endpoints: HashSet::new(),
                last_media_url: None,
                proxy_pool_size: 0,
                last_checked_at: None,
                message: None,
                message_key: None,
                message_args: None,
            }),
        }
    }

    fn bump_auto_scan_epoch(&self) -> u64 {
        self.auto_scan_epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_auto_scan_epoch_active(&self, scan_epoch: u64) -> bool {
        self.auto_scan_epoch.load(Ordering::SeqCst) == scan_epoch
    }

    async fn apply_settings_inner(
        self: &Arc<Self>,
        payload: MediaProxySettingsPayload,
    ) -> Result<MediaProxyStatus, String> {
        let requested_mode = payload.mode;
        let last_known_working_proxy = payload.last_known_working_proxy.clone();
        let scan_epoch = self.bump_auto_scan_epoch();
        let manual = normalize_manual_proxy_settings(&payload);
        {
            let mut inner = self.inner.write().await;
            inner.config = MediaProxyConfig {
                mode: requested_mode,
                manual,
            };
            inner.routing = ProxyRouting::Direct;
            inner.standby_proxy = None;
            inner.active_proxy = None;
            inner.blacklisted_endpoints.clear();
            inner.proxy_pool_size = 0;
            inner.last_checked_at = Some(now_secs());
            inner.message = None;
            inner.message_key = None;
            inner.message_args = None;
        }

        match requested_mode {
            MediaProxyMode::Off => {
                self.set_message(None, None).await;
            }
            MediaProxyMode::Manual => {
                let manual = {
                    let inner = self.inner.read().await;
                    inner.config.manual.clone()
                };
                if let Some(manual) = manual {
                    let candidate = ProxyCandidate {
                        host: manual.host,
                        port: manual.port,
                        username: manual.username,
                        password: manual.password,
                        type_hint: manual.type_hint,
                        source: "manual",
                    };
                    if let Some(validated) =
                        validate_proxy_candidate(
                            self,
                            candidate,
                            self.auto_scan_epoch.load(Ordering::SeqCst),
                            None,
                            true,
                        )
                        .await
                    {
                        let mut inner = self.inner.write().await;
                        inner.active_proxy = Some(validated.clone());
                        inner.routing = ProxyRouting::Proxy;
                        inner.proxy_pool_size = 1;
                        inner.last_checked_at = Some(validated.last_checked_at);
                        inner.message = None;
                        inner.message_key = None;
                        inner.message_args = None;
                    } else {
                        self.set_message(Some(MSG_MANUAL_INVALID), None).await;
                    }
                } else {
                    self.set_message(Some(MSG_MANUAL_MISSING_HOST_PORT), None)
                        .await;
                }
            }
            MediaProxyMode::Auto => {
                let restored = if let Some(snapshot) = last_known_working_proxy {
                    self.restore_previous_proxy(snapshot, scan_epoch).await?
                } else {
                    false
                };

                if !restored {
                    let result = self.refresh_auto_pool_inner(None, scan_epoch).await?;
                    if matches!(result, AutoPoolRefreshResult::None) {
                        self.set_message(Some(MSG_AUTO_UNAVAILABLE), None).await;
                    }
                }
            }
        }

        let status = self.build_status().await;
        self.emit_status("media-proxy:status", &status);
        Ok(status)
    }

    async fn refresh_auto_inner(self: &Arc<Self>) -> Result<MediaProxyStatus, String> {
        {
            let inner = self.inner.read().await;
            if inner.config.mode != MediaProxyMode::Auto {
                return Ok(self.build_status().await);
            }
        }

        let scan_epoch = self.bump_auto_scan_epoch();
        if let AutoPoolRefreshResult::Selected(proxy) =
            self.refresh_auto_pool_inner(None, scan_epoch).await?
        {
            let endpoint = proxy.candidate.endpoint_label();
            {
                let mut inner = self.inner.write().await;
                if self.is_auto_scan_epoch_active(scan_epoch) {
                    inner.routing = ProxyRouting::Proxy;
                    inner.active_proxy = Some(proxy.clone());
                    inner.standby_proxy = Some(proxy);
                    inner.last_checked_at = Some(now_secs());
                    inner.message = None;
                    inner.message_key = None;
                    inner.message_args = None;
                }
            }
            log_auto_proxy(format!(
                "Manual refresh connected proxy {endpoint}"
            ));
        }
        let status = self.build_status().await;
        self.emit_status("media-proxy:status", &status);
        Ok(status)
    }

    async fn report_degraded_inner(
        self: &Arc<Self>,
        reason: String,
    ) -> Result<MediaProxyStatus, String> {
        let active_proxy = {
            let mut inner = self.inner.write().await;
            if inner.config.mode != MediaProxyMode::Auto {
                return Ok(self.build_status().await);
            }

            let active = inner.active_proxy.clone();
            if let Some(proxy) = active.as_ref() {
                log_auto_proxy(format!("Proxy marked degraded: {reason}"));
                log_auto_proxy(format!("Blacklisted endpoint {}", proxy.candidate.endpoint_label()));
                inner.blacklisted_endpoints.insert(proxy.endpoint_key());
                inner.active_proxy = None;
                inner.standby_proxy = None;
                inner.routing = ProxyRouting::Direct;
                inner.last_checked_at = Some(now_secs());
            }
            active
        };

        if let Some(proxy) = active_proxy.as_ref() {
            log_auto_proxy(format!(
                "Active proxy disconnected {}",
                proxy.candidate.endpoint_label()
            ));
        }
        log_auto_proxy("Searching replacement proxy");

        let scan_epoch = self.bump_auto_scan_epoch();
        let replacement = self.refresh_auto_pool_inner(None, scan_epoch).await?;
        if let AutoPoolRefreshResult::Selected(proxy) = replacement {
            {
                let mut inner = self.inner.write().await;
                inner.routing = ProxyRouting::Proxy;
                inner.active_proxy = Some(proxy.clone());
                inner.standby_proxy = Some(proxy.clone());
                inner.last_checked_at = Some(now_secs());
                inner.message = None;
                inner.message_key = Some(MSG_AUTO_FALLBACK_NOTICE.to_string());
                inner.message_args = None;
            }
            log_auto_proxy(format!(
                "Active proxy locked {}",
                proxy.candidate.endpoint_label()
            ));
            let status = self.build_status().await;
            self.emit_status("media-proxy:auto-fallback", &status);
            self.emit_status("media-proxy:status", &status);
            return Ok(status);
        }

        self.set_message(
            Some(MSG_AUTO_NO_REPLACEMENT),
            Some(message_args([("reason", reason.clone())])),
        )
        .await;
        let status = self.build_status().await;
        self.emit_status("media-proxy:status", &status);
        Ok(status)
    }

    async fn restore_previous_proxy(
        self: &Arc<Self>,
        snapshot: MediaProxySessionSnapshot,
        scan_epoch: u64,
    ) -> Result<bool, String> {
        if snapshot.mode != MediaProxyMode::Auto {
            return Ok(false);
        }

        log_auto_proxy("Restoring previous proxy session");
        let Some(snapshot_proxy) = ValidatedProxy::from_snapshot(&snapshot, "restore") else {
            log_auto_proxy("Previous proxy invalid, starting fallback discovery");
            let mut inner = self.inner.write().await;
            inner
                .blacklisted_endpoints
                .insert(format!("{}:{}", snapshot.host.trim(), snapshot.port));
            inner.last_checked_at = Some(now_secs());
            return Ok(false);
        };
        let validation_url = {
            let inner = self.inner.read().await;
            inner.last_media_url.clone()
        };
        let validated = validate_proxy_candidate(
            self,
            snapshot_proxy.candidate,
            scan_epoch,
            validation_url.as_deref(),
            true,
        )
        .await;
        if !self.is_auto_scan_epoch_active(scan_epoch) {
            return Ok(false);
        }
        let Some(validated) = validated else {
            log_auto_proxy("Previous proxy invalid, starting fallback discovery");
            let mut inner = self.inner.write().await;
            inner
                .blacklisted_endpoints
                .insert(format!("{}:{}", snapshot.host.trim(), snapshot.port));
            inner.last_checked_at = Some(now_secs());
            return Ok(false);
        };

        {
            let mut inner = self.inner.write().await;
            inner.routing = ProxyRouting::Proxy;
            inner.active_proxy = Some(validated.clone());
            inner.standby_proxy = Some(validated.clone());
            inner.proxy_pool_size = 1;
            inner.last_checked_at = Some(validated.last_checked_at);
            inner.message = None;
            inner.message_key = None;
            inner.message_args = None;
        }
        log_auto_proxy("Previous proxy still working");
        log_auto_proxy(format!(
            "Active proxy locked {}",
            validated.candidate.endpoint_label()
        ));
        log_auto_proxy("Skipped fresh auto scan and reused previous proxy session");
        Ok(true)
    }

    async fn refresh_auto_pool_inner(
        self: &Arc<Self>,
        exclude_key: Option<String>,
        scan_epoch: u64,
    ) -> Result<AutoPoolRefreshResult, String> {
        let exclude_key = exclude_key.unwrap_or_default();
        let blacklisted_endpoints = {
            let inner = self.inner.read().await;
            inner.blacklisted_endpoints.clone()
        };
        if !self.is_auto_scan_epoch_active(scan_epoch) {
            log_auto_proxy("Background proxy scanning stopped");
            return Ok(AutoPoolRefreshResult::Cancelled);
        }
        log_auto_proxy(format!(
            "Refreshing auto proxy pool exclude_key={} blacklisted={}",
            if exclude_key.is_empty() {
                "<none>".to_string()
            } else {
                exclude_key.clone()
            },
            blacklisted_endpoints.len()
        ));

        let client = build_http_client(
            ClientProfile::Generic,
            None,
            Some(Duration::from_millis(7000)),
        )?;

        let validation_url = {
            let inner = self.inner.read().await;
            inner.last_media_url.clone()
        };
        let mut pool_size = 0usize;
        let mut selected = None;

        let (source_selected, source_pool_size, cancelled) = fetch_belurk_candidates(
            self,
            &client,
            scan_epoch,
            &exclude_key,
            &blacklisted_endpoints,
            validation_url.as_deref(),
        )
        .await;
        if cancelled || !self.is_auto_scan_epoch_active(scan_epoch) {
            log_auto_proxy("Background proxy scanning stopped");
            return Ok(AutoPoolRefreshResult::Cancelled);
        }
        pool_size += source_pool_size;
        selected = selected.or(source_selected);

        if selected.is_none() {
            let (source_selected, source_pool_size, cancelled) = fetch_gologin_candidates(
                self,
                &client,
                scan_epoch,
                &exclude_key,
                &blacklisted_endpoints,
                validation_url.as_deref(),
            )
            .await;
            if cancelled || !self.is_auto_scan_epoch_active(scan_epoch) {
                log_auto_proxy("Background proxy scanning stopped");
                return Ok(AutoPoolRefreshResult::Cancelled);
            }
            pool_size += source_pool_size;
            selected = selected.or(source_selected);
        }

        if selected.is_none() {
            let (source_selected, source_pool_size, cancelled) = fetch_toproxylab_candidates(
                self,
                &client,
                scan_epoch,
                &exclude_key,
                &blacklisted_endpoints,
                validation_url.as_deref(),
            )
            .await;
            if cancelled || !self.is_auto_scan_epoch_active(scan_epoch) {
                log_auto_proxy("Background proxy scanning stopped");
                return Ok(AutoPoolRefreshResult::Cancelled);
            }
            pool_size += source_pool_size;
            selected = selected.or(source_selected);
        }

        if let Some(proxy) = selected.as_ref() {
            log_auto_proxy(format!(
                "Active proxy: {} type={} latency={}ms throughput={}kb/s source={}",
                proxy.candidate.endpoint_label(),
                proxy.proxy_type.as_label(),
                proxy.latency_ms,
                proxy.throughput_kbps,
                proxy.candidate.source
            ));
            log_auto_proxy("Stopped further proxy scanning");
        } else {
            log_auto_proxy("No suitable auto proxies found after validation");
        }

        let mut inner = self.inner.write().await;
        if !self.is_auto_scan_epoch_active(scan_epoch) {
            return Ok(AutoPoolRefreshResult::Cancelled);
        }
        inner.proxy_pool_size = pool_size;
        inner.last_checked_at = Some(now_secs());
        inner.standby_proxy = selected.clone();
        if inner.routing != ProxyRouting::Proxy {
            inner.active_proxy = None;
        }
        if selected.is_some() {
            inner.message = None;
            inner.message_key = None;
            inner.message_args = None;
        }
        Ok(match selected {
            Some(proxy) => AutoPoolRefreshResult::Selected(proxy),
            None => AutoPoolRefreshResult::None,
        })
    }

    async fn set_message(
        &self,
        message_key: Option<&str>,
        message_args: Option<HashMap<String, String>>,
    ) {
        let mut inner = self.inner.write().await;
        inner.message = None;
        inner.message_key = message_key.map(str::to_string);
        inner.message_args = message_args.filter(|args| !args.is_empty());
        inner.last_checked_at = Some(now_secs());
    }

    async fn remember_media_url(&self, url: &str, profile: ClientProfile) {
        if !matches!(profile, ClientProfile::Download | ClientProfile::Storage)
            && !looks_like_media_stream_url(url)
        {
            return;
        }

        let mut inner = self.inner.write().await;
        inner.last_media_url = Some(url.to_string());
    }

    async fn build_status(&self) -> MediaProxyStatus {
        let inner = self.inner.read().await;
        let selected = match (inner.config.mode, inner.routing) {
            (MediaProxyMode::Manual, ProxyRouting::Proxy) => inner.active_proxy.as_ref(),
            (MediaProxyMode::Auto, ProxyRouting::Proxy) => inner.active_proxy.as_ref(),
            (MediaProxyMode::Auto, ProxyRouting::Direct) => inner.standby_proxy.as_ref(),
            _ => None,
        };

        let state = match inner.config.mode {
            MediaProxyMode::Off => "disabled",
            MediaProxyMode::Manual => {
                if inner.active_proxy.is_some() {
                    "proxy-active"
                } else {
                    "invalid"
                }
            }
            MediaProxyMode::Auto => {
                if inner.routing == ProxyRouting::Proxy && inner.active_proxy.is_some() {
                    "proxy-active"
                } else if inner.standby_proxy.is_some() {
                    "standby"
                } else {
                    "direct"
                }
            }
        };

        MediaProxyStatus {
            mode: inner.config.mode,
            routing: match inner.routing {
                ProxyRouting::Direct => "direct".to_string(),
                ProxyRouting::Proxy => "proxy".to_string(),
            },
            state: state.to_string(),
            proxy_type: selected.map(|proxy| proxy.proxy_type.as_label().to_string()),
            endpoint: selected.map(|proxy| proxy.endpoint_label()),
            latency_ms: selected.map(|proxy| proxy.latency_ms),
            throughput_kbps: selected.map(|proxy| proxy.throughput_kbps),
            proxy_pool_size: inner.proxy_pool_size,
            last_checked_at: inner.last_checked_at,
            message: inner.message.clone(),
            message_key: inner.message_key.clone(),
            message_args: inner.message_args.clone(),
            last_known_working_proxy: if inner.config.mode == MediaProxyMode::Auto {
                inner
                    .active_proxy
                    .as_ref()
                    .map(|proxy| proxy.to_snapshot(MediaProxyMode::Auto, ProxyRouting::Proxy))
                    .or_else(|| {
                        inner.standby_proxy.as_ref().map(|proxy| {
                            proxy.to_snapshot(MediaProxyMode::Auto, ProxyRouting::Direct)
                        })
                    })
            } else {
                None
            },
        }
    }

    async fn select_decision(self: &Arc<Self>) -> RoutingDecision {
        let inner = self.inner.read().await;
        match inner.config.mode {
            MediaProxyMode::Off => RoutingDecision {
                mode: MediaProxyMode::Off,
                routing: ProxyRouting::Direct,
                proxy: None,
            },
            MediaProxyMode::Manual => RoutingDecision {
                mode: MediaProxyMode::Manual,
                routing: if inner.active_proxy.is_some() {
                    ProxyRouting::Proxy
                } else {
                    ProxyRouting::Direct
                },
                proxy: inner.active_proxy.clone(),
            },
            MediaProxyMode::Auto => {
                if inner.routing == ProxyRouting::Proxy {
                    RoutingDecision {
                        mode: MediaProxyMode::Auto,
                        routing: ProxyRouting::Proxy,
                        proxy: inner.active_proxy.clone(),
                    }
                } else {
                    RoutingDecision {
                        mode: MediaProxyMode::Auto,
                        routing: ProxyRouting::Direct,
                        proxy: None,
                    }
                }
            }
        }
    }

    async fn note_success(&self, decision: &RoutingDecision, latency_ms: u64, throughput: Option<u64>) {
        if decision.routing != ProxyRouting::Proxy {
            return;
        }

        let mut inner = self.inner.write().await;
        if let Some(proxy) = inner.active_proxy.as_mut() {
            proxy.latency_ms = latency_ms;
            if let Some(throughput) = throughput.filter(|value| *value > 0) {
                proxy.throughput_kbps = throughput;
            }
            proxy.last_checked_at = now_secs();
            inner.last_checked_at = Some(proxy.last_checked_at);
            inner.message = None;
            inner.message_key = None;
            inner.message_args = None;
            return;
        }

        if let Some(proxy) = inner.standby_proxy.as_mut() {
            proxy.latency_ms = latency_ms;
            if let Some(throughput) = throughput.filter(|value| *value > 0) {
                proxy.throughput_kbps = throughput;
            }
            proxy.last_checked_at = now_secs();
            inner.last_checked_at = Some(proxy.last_checked_at);
            inner.message = None;
            inner.message_key = None;
            inner.message_args = None;
        }
    }

    async fn handle_failure(
        self: &Arc<Self>,
        decision: &RoutingDecision,
        reason: String,
    ) -> Result<Option<RoutingDecision>, String> {
        match decision.mode {
            MediaProxyMode::Off => Ok(None),
            MediaProxyMode::Manual => {
                self.set_message(
                    Some(MSG_MANUAL_FAILED),
                    Some(message_args([("reason", reason)])),
                )
                .await;
                let status = self.build_status().await;
                self.emit_status("media-proxy:status", &status);
                Ok(None)
            }
            MediaProxyMode::Auto => {
                log_auto_proxy(format!(
                    "Handling media failure routing={} reason={reason}",
                    if decision.routing == ProxyRouting::Proxy {
                        "proxy"
                    } else {
                        "direct"
                    }
                ));
                if decision.routing == ProxyRouting::Proxy {
                    log_auto_proxy(
                        "Keeping active proxy locked after transient request failure; waiting for real degradation signal",
                    );
                    let status = self.build_status().await;
                    self.emit_status("media-proxy:status", &status);
                    Ok(None)
                } else {
                    let standby = {
                        let inner = self.inner.read().await;
                        inner.standby_proxy.clone()
                    };
                    log_auto_proxy("Refreshing auto proxy pool before switching direct media routing");
                    let scan_epoch = self.bump_auto_scan_epoch();
                    let next_proxy = match self.refresh_auto_pool_inner(None, scan_epoch).await? {
                        AutoPoolRefreshResult::Selected(proxy) => Some(proxy),
                        AutoPoolRefreshResult::None | AutoPoolRefreshResult::Cancelled => standby,
                    };

                    if let Some(proxy) = next_proxy {
                        log_auto_proxy(format!(
                            "Switching direct media routing to proxy {} type={} latency={}ms throughput={}kb/s",
                            proxy.candidate.endpoint_label(),
                            proxy.proxy_type.as_label(),
                            proxy.latency_ms,
                            proxy.throughput_kbps
                        ));
                        {
                            let mut inner = self.inner.write().await;
                            inner.routing = ProxyRouting::Proxy;
                            inner.active_proxy = Some(proxy.clone());
                            inner.standby_proxy = Some(proxy.clone());
                            inner.last_checked_at = Some(now_secs());
                            inner.message = None;
                            inner.message_key = Some(MSG_AUTO_FALLBACK_NOTICE.to_string());
                            inner.message_args = None;
                        }
                        log_auto_proxy(format!(
                            "Active proxy locked {}",
                            proxy.candidate.endpoint_label()
                        ));
                        let status = self.build_status().await;
                        self.emit_status("media-proxy:auto-fallback", &status);
                        self.emit_status("media-proxy:status", &status);
                        return Ok(Some(RoutingDecision {
                            mode: MediaProxyMode::Auto,
                            routing: ProxyRouting::Proxy,
                            proxy: Some(proxy),
                        }));
                    }

                    self.set_message(
                        Some(MSG_AUTO_NO_REPLACEMENT),
                        Some(message_args([("reason", reason)])),
                    )
                    .await;
                    let status = self.build_status().await;
                    self.emit_status("media-proxy:status", &status);
                    Ok(None)
                }
            }
        }
    }

    fn emit_status(&self, event: &str, status: &MediaProxyStatus) {
        let _ = self.app.emit(event, status.clone());
    }
}

impl MediaProxyType {
    fn as_label(self) -> &'static str {
        match self {
            MediaProxyType::Http => "http",
            MediaProxyType::Https => "https",
            MediaProxyType::Socks4 => "socks4",
            MediaProxyType::Socks5 => "socks5",
        }
    }
}

impl ValidatedProxy {
    fn from_snapshot(
        snapshot: &MediaProxySessionSnapshot,
        source: &'static str,
    ) -> Option<Self> {
        let host = snapshot.host.trim().to_string();
        if host.is_empty() || snapshot.port == 0 {
            return None;
        }

        Some(Self {
            candidate: ProxyCandidate {
                host,
                port: snapshot.port,
                username: snapshot.username.clone(),
                password: snapshot.password.clone(),
                type_hint: Some(snapshot.proxy_type),
                source,
            },
            proxy_type: snapshot.proxy_type,
            latency_ms: snapshot.latency_ms.unwrap_or(1).max(1),
            throughput_kbps: snapshot.throughput_kbps.unwrap_or(0),
            last_checked_at: snapshot.last_checked_at.unwrap_or_else(now_secs),
        })
    }

    fn cache_key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.proxy_type.as_label(),
            self.candidate.host,
            self.candidate.port
        )
    }

    fn endpoint_label(&self) -> String {
        format!("{}:{} ({})", self.candidate.host, self.candidate.port, self.proxy_type.as_label())
    }

    fn endpoint_key(&self) -> String {
        self.candidate.endpoint_key()
    }

    fn to_snapshot(
        &self,
        mode: MediaProxyMode,
        routing: ProxyRouting,
    ) -> MediaProxySessionSnapshot {
        MediaProxySessionSnapshot {
            mode,
            routing: match routing {
                ProxyRouting::Direct => "direct".to_string(),
                ProxyRouting::Proxy => "proxy".to_string(),
            },
            host: self.candidate.host.clone(),
            port: self.candidate.port,
            username: self.candidate.username.clone(),
            password: self.candidate.password.clone(),
            proxy_type: self.proxy_type,
            latency_ms: Some(self.latency_ms),
            throughput_kbps: Some(self.throughput_kbps),
            last_checked_at: Some(self.last_checked_at),
        }
    }
}

impl ProxyCandidate {
    fn endpoint_label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    fn endpoint_key(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    fn type_hint_label(&self) -> &'static str {
        self.type_hint
            .map(MediaProxyType::as_label)
            .unwrap_or("auto")
    }

    fn candidate_types(&self) -> Vec<MediaProxyType> {
        if let Some(type_hint) = self.type_hint {
            return vec![type_hint];
        }

        let port_guess = match self.port {
            1080 | 1081 | 1085 | 4145 | 9050 | 9051 => {
                vec![MediaProxyType::Socks5, MediaProxyType::Socks4]
            }
            443 | 8443 | 9443 => vec![MediaProxyType::Https, MediaProxyType::Http],
            80 | 81 | 3128 | 8000 | 8080 | 8081 | 8088 | 8888 => {
                vec![MediaProxyType::Http, MediaProxyType::Https]
            }
            _ if self.username.is_some() || self.password.is_some() => {
                vec![MediaProxyType::Socks5, MediaProxyType::Https, MediaProxyType::Http]
            }
            _ => vec![MediaProxyType::Http, MediaProxyType::Https, MediaProxyType::Socks5],
        };

        let mut unique = Vec::new();
        for proxy_type in port_guess {
            if !unique.contains(&proxy_type) {
                unique.push(proxy_type);
            }
        }
        unique
    }
}

pub fn init(app: tauri::AppHandle) -> Arc<MediaProxyState> {
    let state = Arc::new(MediaProxyState::new(app));
    let _ = STATE.set(state.clone());
    state
}

fn shared() -> Result<Arc<MediaProxyState>, String> {
    STATE
        .get()
        .cloned()
        .ok_or_else(|| "media proxy state is not ready".to_string())
}

fn message_args<const N: usize>(entries: [(&str, String); N]) -> HashMap<String, String> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn log_auto_proxy(message: impl AsRef<str>) {
    println!("[AUTO_PROXY] {}", message.as_ref());
}

fn log_auto_proxy_error(message: impl AsRef<str>) {
    eprintln!("[AUTO_PROXY] {}", message.as_ref());
}

fn log_proxy_test(message: impl AsRef<str>) {
    println!("[PROXY_TEST] {}", message.as_ref());
}

fn log_proxy_test_error(message: impl AsRef<str>) {
    eprintln!("[PROXY_TEST] {}", message.as_ref());
}

pub async fn perform_get(
    url: &str,
    headers: &[(String, String)],
    accept: Option<&str>,
    profile: ClientProfile,
) -> Result<(Response, RoutingDecision, u64), String> {
    let state = shared()?;
    state.remember_media_url(url, profile).await;
    let mut decision = state.select_decision().await;

    for attempt in 0..2 {
        let client = decision.build_client(profile)?;
        let started = Instant::now();
        let mut request = client.get(url);
        request = request
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE);

        if let Some(accept) = accept.filter(|value| !value.trim().is_empty()) {
            request = request.header(ACCEPT, accept);
        }

        for (name, value) in headers {
            let header_name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?;
            let header_value = HeaderValue::from_str(value).map_err(|error| error.to_string())?;
            request = request.header(header_name, header_value);
        }

        match request.send().await {
            Ok(response) => {
                let latency_ms = started.elapsed().as_millis() as u64;
                if response.status().is_success() || response.status() == StatusCode::PARTIAL_CONTENT
                {
                    state.note_success(&decision, latency_ms, None).await;
                    return Ok((response, decision, latency_ms));
                }

                if attempt == 0 {
                    let reason = format!("HTTP {}", response.status());
                    if let Some(next) = state.handle_failure(&decision, reason).await? {
                        decision = next;
                        continue;
                    }
                }

                return Ok((response, decision, latency_ms));
            }
            Err(error) => {
                let formatted = format_reqwest_error(&error);
                if attempt == 0 {
                    if let Some(next) = state.handle_failure(&decision, formatted.clone()).await? {
                        decision = next;
                        continue;
                    }
                }
                return Err(formatted);
            }
        }
    }

    Err("media request failed".to_string())
}

pub async fn fetch_bytes(
    url: &str,
    headers: &[(String, String)],
    accept: Option<&str>,
    profile: ClientProfile,
) -> Result<MediaBytesResponse, String> {
    let state = shared()?;
    let (response, decision, latency_ms) = perform_get(url, headers, accept, profile).await?;
    let status = response.status().as_u16();
    let started = Instant::now();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format_reqwest_error(&error))?;
    let throughput = if !bytes.is_empty() {
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        Some(((bytes.len() as f64 * 8.0) / elapsed / 1000.0).round() as u64)
    } else {
        None
    };
    state.note_success(&decision, latency_ms, throughput).await;
    Ok(MediaBytesResponse {
        status,
        data: bytes.to_vec(),
    })
}

#[tauri::command]
pub async fn media_proxy_apply_settings(
    settings: MediaProxySettingsPayload,
) -> Result<MediaProxyStatus, String> {
    shared()?.apply_settings_inner(settings).await
}

#[tauri::command]
pub async fn media_proxy_get_status() -> Result<MediaProxyStatus, String> {
    Ok(shared()?.build_status().await)
}

#[tauri::command]
pub async fn media_proxy_refresh_auto() -> Result<MediaProxyStatus, String> {
    shared()?.refresh_auto_inner().await
}

#[tauri::command]
pub async fn media_proxy_report_degraded(reason: String) -> Result<MediaProxyStatus, String> {
    shared()?.report_degraded_inner(reason).await
}

#[tauri::command]
pub async fn media_proxy_http_get(
    url: String,
    accept: Option<String>,
    headers: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<MediaHttpResponse, String> {
    let timeout_ms = timeout_ms.filter(|value| *value >= 1000);
    let extra_headers = headers
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<(String, String)>>();
    shared()?.remember_media_url(&url, ClientProfile::Generic).await;
    let (response, decision, latency_ms) = if let Some(timeout_ms) = timeout_ms {
        let state = shared()?;
        let mut decision = state.select_decision().await;
        let mut response_slot = None;
        for attempt in 0..2 {
            let client = build_http_client(
                ClientProfile::Generic,
                decision.proxy.as_ref(),
                Some(Duration::from_millis(timeout_ms)),
            )?;
            let started = Instant::now();
            let mut request = client
                .get(&url)
                .header(USER_AGENT, DEFAULT_USER_AGENT)
                .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE);
            if let Some(accept) = accept.as_deref().filter(|value| !value.trim().is_empty()) {
                request = request.header(ACCEPT, accept);
            }
            for (name, value) in &extra_headers {
                let header_name =
                    HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?;
                let header_value =
                    HeaderValue::from_str(value).map_err(|error| error.to_string())?;
                request = request.header(header_name, header_value);
            }
            match request.send().await {
                Ok(response) => {
                    let latency_ms = started.elapsed().as_millis() as u64;
                    if response.status().is_success()
                        || response.status() == StatusCode::PARTIAL_CONTENT
                    {
                        state.note_success(&decision, latency_ms, None).await;
                        response_slot = Some((response, decision, latency_ms));
                        break;
                    }
                    if attempt == 0 {
                        let reason = format!("HTTP {}", response.status());
                        if let Some(next) = state.handle_failure(&decision, reason).await? {
                            decision = next;
                            continue;
                        }
                    }
                    response_slot = Some((response, decision, latency_ms));
                    break;
                }
                Err(error) => {
                    let formatted = format_reqwest_error(&error);
                    if attempt == 0 {
                        if let Some(next) = state.handle_failure(&decision, formatted.clone()).await?
                        {
                            decision = next;
                            continue;
                        }
                    }
                    return Err(formatted);
                }
            }
        }
        response_slot.ok_or_else(|| "media request failed".to_string())?
    } else {
        perform_get(
            &url,
            &extra_headers,
            accept.as_deref(),
            ClientProfile::Generic,
        )
        .await?
    };

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = response.text().await.map_err(|error| format_reqwest_error(&error))?;
    shared()?.note_success(&decision, latency_ms, None).await;

    Ok(MediaHttpResponse {
        status,
        content_type,
        body,
    })
}

fn format_reqwest_error(error: &reqwest::Error) -> String {
    let mut details = Vec::new();
    if error.is_timeout() {
        details.push("timeout".to_string());
    } else if error.is_connect() {
        details.push("connect".to_string());
    } else if error.is_redirect() {
        details.push("redirect".to_string());
    } else if error.is_body() {
        details.push("body".to_string());
    } else if error.is_decode() {
        details.push("decode".to_string());
    } else if error.is_request() {
        details.push("request".to_string());
    }

    if let Some(status) = error.status() {
        details.push(format!("HTTP {status}"));
    }

    let mut message = error.to_string();
    if !details.is_empty() {
        message.push_str(&format!(" [{}]", details.join(", ")));
    }
    message
}

fn build_http_client(
    profile: ClientProfile,
    proxy: Option<&ValidatedProxy>,
    timeout_override: Option<Duration>,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .tcp_nodelay(true);

    builder = match profile {
        ClientProfile::Generic => builder
            .pool_max_idle_per_host(8)
            .connect_timeout(Duration::from_millis(1800))
            .timeout(timeout_override.unwrap_or(Duration::from_millis(8500))),
        ClientProfile::Download => builder
            .pool_max_idle_per_host(16)
            .connect_timeout(Duration::from_millis(1500))
            .read_timeout(timeout_override.unwrap_or(Duration::from_secs(20))),
        ClientProfile::Storage => builder
            .pool_max_idle_per_host(4)
            .connect_timeout(Duration::from_millis(800))
            .timeout(timeout_override.unwrap_or(Duration::from_millis(1200))),
        ClientProfile::Validation => builder
            .pool_max_idle_per_host(8)
            .connect_timeout(Duration::from_millis(VALIDATION_CONNECT_TIMEOUT_MS))
            .read_timeout(timeout_override.unwrap_or(Duration::from_secs(
                VALIDATION_READ_TIMEOUT_SECS,
            ))),
    };

    if let Some(proxy) = proxy {
        let proxy_url = build_proxy_url(
            proxy.proxy_type,
            &proxy.candidate.host,
            proxy.candidate.port,
            proxy.candidate.username.as_deref(),
            proxy.candidate.password.as_deref(),
        );
        let reqwest_proxy = reqwest::Proxy::all(proxy_url).map_err(|error| error.to_string())?;
        builder = builder.proxy(reqwest_proxy);
    }

    builder.build().map_err(|error| error.to_string())
}

fn build_proxy_url(
    proxy_type: MediaProxyType,
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> String {
    let scheme = match proxy_type {
        MediaProxyType::Http => "http",
        MediaProxyType::Https => "https",
        MediaProxyType::Socks4 => "socks4a",
        MediaProxyType::Socks5 => "socks5h",
    };

    let auth = username
        .filter(|value| !value.trim().is_empty())
        .map(|username| {
            let encoded_user = urlencoding::encode(username.trim());
            let encoded_pass = urlencoding::encode(password.unwrap_or_default().trim());
            format!("{encoded_user}:{encoded_pass}@")
        })
        .unwrap_or_default();

    format!("{scheme}://{auth}{host}:{port}")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn normalize_manual_proxy_settings(payload: &MediaProxySettingsPayload) -> Option<ManualProxySettings> {
    let raw_host = payload.host.as_deref()?.trim();
    if raw_host.is_empty() {
        return None;
    }

    let mut host = raw_host.to_string();
    let mut port = payload.port.unwrap_or(0);
    let mut type_hint = None;
    let mut username = payload
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut password = payload
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if let Ok(parsed) = reqwest::Url::parse(raw_host) {
        host = parsed.host_str()?.to_string();
        if let Some(parsed_port) = parsed.port() {
            port = parsed_port;
        }
        type_hint = match parsed.scheme().to_ascii_lowercase().as_str() {
            "http" => Some(MediaProxyType::Http),
            "https" => Some(MediaProxyType::Https),
            "socks4" | "socks4a" => Some(MediaProxyType::Socks4),
            "socks5" | "socks5h" => Some(MediaProxyType::Socks5),
            _ => None,
        };
        if username.is_none() && !parsed.username().trim().is_empty() {
            username = Some(parsed.username().trim().to_string());
        }
        if password.is_none() {
            password = parsed.password().map(str::to_string);
        }
    } else if port == 0 {
        let parts = raw_host.rsplitn(2, ':').collect::<Vec<_>>();
        if parts.len() == 2 {
            if let Ok(parsed_port) = parts[0].parse::<u16>() {
                port = parsed_port;
                host = parts[1].trim().to_string();
            }
        }
    }

    if host.is_empty() || port == 0 {
        return None;
    }

    Some(ManualProxySettings {
        host,
        port,
        username,
        password,
        type_hint,
    })
}

#[derive(Debug, serde::Deserialize)]
struct BelurkApiResponse {
    #[serde(default)]
    data: Vec<BelurkProxyRecord>,
}

#[derive(Debug, serde::Deserialize)]
struct BelurkProxyRecord {
    ip_address: String,
    port: u16,
    #[serde(default)]
    protocol: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GologinProxyRecord {
    address: String,
    #[serde(default)]
    protocols: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ToproxylabAjaxResponse {
    success: bool,
    data: ToproxylabAjaxData,
}

#[derive(Debug, serde::Deserialize)]
struct ToproxylabAjaxData {
    #[serde(default)]
    proxies: Vec<ToproxylabProxyRecord>,
    #[serde(default)]
    pages: Option<usize>,
}

#[derive(Debug, serde::Deserialize)]
struct ToproxylabProxyRecord {
    ip: String,
    port: u16,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    https: bool,
}

async fn fetch_belurk_candidates(
    state: &MediaProxyState,
    client: &Client,
    scan_epoch: u64,
    exclude_key: &str,
    blacklisted_endpoints: &HashSet<String>,
    validation_url: Option<&str>,
) -> (Option<ValidatedProxy>, usize, bool) {
    if validation_url.is_none() {
        log_auto_proxy(
            "No remembered media URL available yet; auto proxy selection deferred until real playback/cache traffic exists",
        );
        return (None, 0, false);
    }

    log_auto_proxy(format!(
        "Scraping source: {} ({})",
        BELURK_SOURCE_LABEL,
        BELURK_SOURCE_PAGE
    ));
    let response = match client
        .get(BELURK_API_URL)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE)
        .header(ACCEPT, "application/json,text/plain,*/*;q=0.8")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to fetch {}: {}",
                BELURK_SOURCE_LABEL,
                format_reqwest_error(&error)
            ));
            return (None, 0, false);
        }
    };
    if !response.status().is_success() {
        log_auto_proxy_error(format!(
            "Failed to fetch {}: HTTP {}",
            BELURK_SOURCE_LABEL,
            response.status()
        ));
        return (None, 0, false);
    }

    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to read {} response: {}",
                BELURK_SOURCE_LABEL,
                format_reqwest_error(&error)
            ));
            return (None, 0, false);
        }
    };
    let payload = match serde_json::from_str::<BelurkApiResponse>(&body) {
        Ok(payload) => payload,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to parse {} payload: {error}",
                BELURK_SOURCE_LABEL
            ));
            return (None, 0, false);
        }
    };

    log_auto_proxy(format!(
        "Found {} proxies from {}",
        payload.data.len(),
        BELURK_SOURCE_LABEL
    ));
    let mut seen = HashSet::new();
    let candidates = collect_unique_candidates(
        parse_belurk_candidates(payload.data),
        &mut seen,
        AUTO_MAX_CANDIDATES,
    );
    let (selected, pool_size) = validate_auto_source(
        state,
        candidates,
        scan_epoch,
        BELURK_SOURCE_LABEL,
        exclude_key,
        blacklisted_endpoints,
        validation_url,
    )
    .await;
    if !state.is_auto_scan_epoch_active(scan_epoch) {
        return (None, pool_size, true);
    }

    (selected, pool_size, false)
}

async fn fetch_gologin_candidates(
    state: &MediaProxyState,
    client: &Client,
    scan_epoch: u64,
    exclude_key: &str,
    blacklisted_endpoints: &HashSet<String>,
    validation_url: Option<&str>,
) -> (Option<ValidatedProxy>, usize, bool) {
    if validation_url.is_none() {
        log_auto_proxy(
            "No remembered media URL available yet; auto proxy selection deferred until real playback/cache traffic exists",
        );
        return (None, 0, false);
    }

    log_auto_proxy(format!(
        "Scraping source: {} ({})",
        GOLOGIN_SOURCE_LABEL,
        GOLOGIN_SOURCE_PAGE
    ));
    let response = match client
        .get(format!("{GOLOGIN_API_URL}?count={GOLOGIN_FETCH_COUNT}"))
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE)
        .header(ACCEPT, "application/json,text/plain,*/*;q=0.8")
        .header("Authorization", GOLOGIN_API_AUTH)
        .header("Content-Type", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to fetch {}: {}",
                GOLOGIN_SOURCE_LABEL,
                format_reqwest_error(&error)
            ));
            return (None, 0, false);
        }
    };
    if !response.status().is_success() {
        log_auto_proxy_error(format!(
            "Failed to fetch {}: HTTP {}",
            GOLOGIN_SOURCE_LABEL,
            response.status()
        ));
        return (None, 0, false);
    }

    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to read {} response: {}",
                GOLOGIN_SOURCE_LABEL,
                format_reqwest_error(&error)
            ));
            return (None, 0, false);
        }
    };
    let payload = match serde_json::from_str::<Vec<GologinProxyRecord>>(&body) {
        Ok(payload) => payload,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to parse {} payload: {error}",
                GOLOGIN_SOURCE_LABEL
            ));
            return (None, 0, false);
        }
    };

    log_auto_proxy(format!(
        "Found {} proxies from {}",
        payload.len(),
        GOLOGIN_SOURCE_LABEL
    ));
    let mut seen = HashSet::new();
    let candidates = collect_unique_candidates(
        parse_gologin_candidates(payload),
        &mut seen,
        AUTO_MAX_CANDIDATES,
    );
    let (selected, pool_size) = validate_auto_source(
        state,
        candidates,
        scan_epoch,
        GOLOGIN_SOURCE_LABEL,
        exclude_key,
        blacklisted_endpoints,
        validation_url,
    )
    .await;
    if !state.is_auto_scan_epoch_active(scan_epoch) {
        return (None, pool_size, true);
    }

    (selected, pool_size, false)
}

async fn fetch_toproxylab_candidates(
    state: &MediaProxyState,
    client: &Client,
    scan_epoch: u64,
    exclude_key: &str,
    blacklisted_endpoints: &HashSet<String>,
    validation_url: Option<&str>,
) -> (Option<ValidatedProxy>, usize, bool) {
    if validation_url.is_none() {
        log_auto_proxy(
            "No remembered media URL available yet; auto proxy selection deferred until real playback/cache traffic exists",
        );
        return (None, 0, false);
    }

    let html = match fetch_source_html(client, TOPROXYLAB_SOURCE_LABEL, TOPROXYLAB_SOURCE_PAGE).await
    {
        Ok(html) => html,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to scrape {}: {error}",
                TOPROXYLAB_SOURCE_LABEL
            ));
            return (None, 0, false);
        }
    };

    let nonce = match parse_toproxylab_nonce(&html) {
        Ok(nonce) => nonce,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to parse {} bootstrap data: {error}",
                TOPROXYLAB_SOURCE_LABEL
            ));
            return (None, 0, false);
        }
    };

    let mut seen = HashSet::new();
    let mut pool_size = 0usize;
    let first_page = match fetch_toproxylab_page(client, &nonce, 1).await {
        Ok(page) => page,
        Err(error) => {
            log_auto_proxy_error(format!(
                "Failed to fetch {} page 1: {error}",
                TOPROXYLAB_SOURCE_LABEL
            ));
            return (None, 0, false);
        }
    };

    log_auto_proxy(format!(
        "Found {} proxies from {} page 1",
        first_page.proxies.len(),
        TOPROXYLAB_SOURCE_LABEL
    ));
    let page_candidates = collect_unique_candidates(
        parse_toproxylab_candidates(first_page.proxies),
        &mut seen,
        AUTO_MAX_CANDIDATES,
    );
    let (selected, page_pool_size) = validate_auto_source(
        state,
        page_candidates,
        scan_epoch,
        TOPROXYLAB_SOURCE_LABEL,
        exclude_key,
        blacklisted_endpoints,
        validation_url,
    )
    .await;
    pool_size += page_pool_size;
    if !state.is_auto_scan_epoch_active(scan_epoch) {
        return (None, pool_size, true);
    }
    if selected.is_some() {
        return (selected, pool_size, false);
    }

    let total_pages = first_page.pages.unwrap_or(1).max(1).min(TOPROXYLAB_MAX_PAGES);
    for page in 2..=total_pages {
        if pool_size >= AUTO_MAX_CANDIDATES {
            break;
        }
        if !state.is_auto_scan_epoch_active(scan_epoch) {
            return (None, pool_size, true);
        }
        tokio::time::sleep(Duration::from_millis(TOPROXYLAB_PAGE_DELAY_MS)).await;
        if !state.is_auto_scan_epoch_active(scan_epoch) {
            return (None, pool_size, true);
        }
        match fetch_toproxylab_page(client, &nonce, page).await {
            Ok(payload) => {
                log_auto_proxy(format!(
                    "Found {} proxies from {} page {}",
                    payload.proxies.len(),
                    TOPROXYLAB_SOURCE_LABEL,
                    page
                ));
                let page_candidates = collect_unique_candidates(
                    parse_toproxylab_candidates(payload.proxies),
                    &mut seen,
                    AUTO_MAX_CANDIDATES.saturating_sub(pool_size),
                );
                let (selected, page_pool_size) = validate_auto_source(
                    state,
                    page_candidates,
                    scan_epoch,
                    TOPROXYLAB_SOURCE_LABEL,
                    exclude_key,
                    blacklisted_endpoints,
                    validation_url,
                )
                .await;
                pool_size += page_pool_size;
                if !state.is_auto_scan_epoch_active(scan_epoch) {
                    return (None, pool_size, true);
                }
                if selected.is_some() {
                    return (selected, pool_size, false);
                }
            }
            Err(error) => {
                log_auto_proxy_error(format!(
                    "Failed to fetch {} page {}: {error}",
                    TOPROXYLAB_SOURCE_LABEL,
                    page
                ));
            }
        }
    }

    log_auto_proxy(format!(
        "Found {} proxies from {}",
        pool_size,
        TOPROXYLAB_SOURCE_LABEL
    ));
    (None, pool_size, false)
}

async fn fetch_source_html(client: &Client, source_label: &str, url: &str) -> Result<String, String> {
    log_auto_proxy(format!("Scraping source: {source_label} ({url})"));
    let response = client
        .get(url)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE)
        .header(ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|error| format_reqwest_error(&error))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format_reqwest_error(&error))?;
    if body.trim().is_empty() {
        return Err("empty response body".to_string());
    }
    if let Some(reason) = detect_anti_bot_challenge(&body) {
        return Err(format!("anti-bot challenge detected: {reason}"));
    }

    Ok(body)
}

fn detect_anti_bot_challenge(body: &str) -> Option<&'static str> {
    let lower = body.to_ascii_lowercase();
    let markers = [
        ("cf-chl-", "cloudflare challenge"),
        ("just a moment", "cloudflare waiting room"),
        ("checking your browser", "browser verification"),
        ("captcha", "captcha"),
        ("browser verification", "browser verification"),
        ("enable javascript", "javascript challenge"),
        ("anti-bot", "anti-bot page"),
        ("challenge-platform", "challenge platform"),
    ];

    for (needle, label) in markers {
        if lower.contains(needle) {
            return Some(label);
        }
    }

    None
}

fn parse_toproxylab_nonce(html: &str) -> Result<String, String> {
    let nonce_re = Regex::new(r#"var\s+NC\s*=\s*["']([^"']+)["']"#)
        .map_err(|error| error.to_string())?;
    nonce_re
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "nonce not found".to_string())
}

async fn fetch_toproxylab_page(
    client: &Client,
    nonce: &str,
    page: usize,
) -> Result<ToproxylabAjaxData, String> {
    log_auto_proxy(format!(
        "Scraping source: {} page {}",
        TOPROXYLAB_SOURCE_LABEL,
        page
    ));
    let response = client
        .post(TOPROXYLAB_AJAX_URL)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE)
        .header(ACCEPT, "application/json,text/javascript,*/*;q=0.8")
        .form(&[
            ("action", TOPROXYLAB_AJAX_ACTION.to_string()),
            ("nonce", nonce.to_string()),
            ("page", page.to_string()),
            ("protocol", "all".to_string()),
            ("country", "".to_string()),
            ("anonymity", "all".to_string()),
        ])
        .send()
        .await
        .map_err(|error| format_reqwest_error(&error))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format_reqwest_error(&error))?;
    if let Some(reason) = detect_anti_bot_challenge(&body) {
        return Err(format!("anti-bot challenge detected: {reason}"));
    }

    let payload = serde_json::from_str::<ToproxylabAjaxResponse>(&body)
        .map_err(|error| format!("invalid ajax response: {error}"))?;
    if !payload.success {
        return Err("ajax returned success=false".to_string());
    }

    Ok(payload.data)
}

fn parse_toproxylab_candidates(records: Vec<ToproxylabProxyRecord>) -> Vec<ProxyCandidate> {
    records
        .into_iter()
        .filter_map(|record| {
            let host = record.ip.trim().to_string();
            if host.is_empty() || record.port == 0 {
                return None;
            }

            Some(ProxyCandidate {
                host,
                port: record.port,
                username: None,
                password: None,
                type_hint: proxy_type_from_toproxylab(record.protocol.as_deref(), record.https),
                source: TOPROXYLAB_SOURCE_LABEL,
            })
        })
        .collect()
}

fn parse_belurk_candidates(records: Vec<BelurkProxyRecord>) -> Vec<ProxyCandidate> {
    records
        .into_iter()
        .filter_map(|record| {
            let host = record.ip_address.trim().to_string();
            if host.is_empty() || record.port == 0 {
                return None;
            }

            Some(ProxyCandidate {
                host,
                port: record.port,
                username: None,
                password: None,
                type_hint: record
                    .protocol
                    .as_deref()
                    .and_then(proxy_type_from_protocol_label),
                source: BELURK_SOURCE_LABEL,
            })
        })
        .collect()
}

fn parse_gologin_candidates(records: Vec<GologinProxyRecord>) -> Vec<ProxyCandidate> {
    let mut candidates = Vec::new();

    for record in records {
        let Some((host_part, port_part)) = record.address.rsplit_once(':') else {
            continue;
        };
        let host = host_part.trim().to_string();
        let port = match port_part.trim().parse::<u16>() {
            Ok(port) if !host.is_empty() && port != 0 => port,
            _ => continue,
        };

        let mut protocol_types = Vec::new();
        for protocol in record.protocols {
            let Some(proxy_type) = proxy_type_from_protocol_label(&protocol) else {
                continue;
            };
            if !protocol_types.contains(&proxy_type) {
                protocol_types.push(proxy_type);
            }
        }

        if protocol_types.is_empty() {
            candidates.push(ProxyCandidate {
                host: host.clone(),
                port,
                username: None,
                password: None,
                type_hint: None,
                source: GOLOGIN_SOURCE_LABEL,
            });
            continue;
        }

        for proxy_type in protocol_types {
            candidates.push(ProxyCandidate {
                host: host.clone(),
                port,
                username: None,
                password: None,
                type_hint: Some(proxy_type),
                source: GOLOGIN_SOURCE_LABEL,
            });
        }
    }

    candidates
}

fn proxy_type_from_toproxylab(protocol: Option<&str>, https: bool) -> Option<MediaProxyType> {
    match protocol
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "http" => Some(if https {
            MediaProxyType::Https
        } else {
            MediaProxyType::Http
        }),
        "https" => Some(MediaProxyType::Https),
        "socks4" => Some(MediaProxyType::Socks4),
        "socks5" => Some(MediaProxyType::Socks5),
        _ if https => Some(MediaProxyType::Https),
        _ => None,
    }
}

fn proxy_type_from_protocol_label(protocol: &str) -> Option<MediaProxyType> {
    match protocol.trim().to_ascii_lowercase().as_str() {
        "http" => Some(MediaProxyType::Http),
        "https" => Some(MediaProxyType::Https),
        "socks4" => Some(MediaProxyType::Socks4),
        "socks5" => Some(MediaProxyType::Socks5),
        _ => None,
    }
}

fn collect_unique_candidates(
    candidates: Vec<ProxyCandidate>,
    seen: &mut HashSet<String>,
    limit: usize,
) -> Vec<ProxyCandidate> {
    if limit == 0 {
        return Vec::new();
    }

    let mut unique = Vec::new();
    for candidate in candidates {
        let key = format!(
            "{}:{}:{}",
            candidate.type_hint_label(),
            candidate.host,
            candidate.port
        );
        if !seen.insert(key) {
            continue;
        }
        unique.push(candidate);
        if unique.len() >= limit {
            break;
        }
    }

    unique
}

async fn validate_proxy_candidate(
    state: &MediaProxyState,
    candidate: ProxyCandidate,
    scan_epoch: u64,
    validation_url: Option<&str>,
    allow_handshake_only: bool,
) -> Option<ValidatedProxy> {
    for proxy_type in candidate.candidate_types() {
        if !state.is_auto_scan_epoch_active(scan_epoch) {
            return None;
        }
        log_auto_proxy(format!(
            "Testing proxy {} ({}) source={}",
            candidate.endpoint_label(),
            proxy_type.as_label().to_ascii_uppercase(),
            candidate.source
        ));
        match validate_proxy_with_type(
            candidate.clone(),
            proxy_type,
            validation_url,
            allow_handshake_only,
        )
        .await
        {
            Ok(validated) => {
                log_auto_proxy(format!(
                    "Proxy accepted latency={}ms throughput={}kb/s endpoint={} type={}",
                    validated.latency_ms,
                    validated.throughput_kbps,
                    validated.candidate.endpoint_label(),
                    validated.proxy_type.as_label()
                ));
                return Some(validated);
            }
            Err(reason) => {
                log_proxy_test_error(format!(
                    "Validation failed endpoint={} type={} source={} reason={reason}",
                    candidate.endpoint_label(),
                    proxy_type.as_label(),
                    candidate.source
                ));
                log_auto_proxy(format!(
                    "Reject {} ({}) source={} reason={reason}",
                    candidate.endpoint_label(),
                    proxy_type.as_label().to_ascii_uppercase(),
                    candidate.source
                ));
            }
        }
    }

    log_auto_proxy(format!(
        "Proxy fully rejected endpoint={} source={}",
        candidate.endpoint_label(),
        candidate.source
    ));
    None
}

async fn validate_proxy_with_type(
    candidate: ProxyCandidate,
    proxy_type: MediaProxyType,
    validation_url: Option<&str>,
    allow_handshake_only: bool,
) -> Result<ValidatedProxy, String> {
    let proxy = ValidatedProxy {
        candidate,
        proxy_type,
        latency_ms: 0,
        throughput_kbps: 0,
        last_checked_at: now_secs(),
    };
    let tcp_latency_ms = test_proxy_tcp_connect(&proxy.candidate).await?;
    log_auto_proxy(format!(
        "TCP handshake success {} latency={}ms",
        proxy.candidate.endpoint_label(),
        tcp_latency_ms
    ));
    log_proxy_test(format!(
        "TCP handshake success endpoint={} latency={}ms",
        proxy.candidate.endpoint_label(),
        tcp_latency_ms
    ));

    let Some(validation_url) = validation_url.filter(|value| !value.trim().is_empty()) else {
        if allow_handshake_only {
            log_proxy_test("No remembered media URL yet, using handshake-only validation");
            return Ok(ValidatedProxy {
                candidate: proxy.candidate,
                proxy_type,
                latency_ms: tcp_latency_ms.max(1),
                throughput_kbps: 0,
                last_checked_at: now_secs(),
            });
        }
        return Err("no remembered media URL available for real track cache validation".to_string());
    };

    let client = build_http_client(
        ClientProfile::Validation,
        Some(&proxy),
        Some(Duration::from_secs(VALIDATION_READ_TIMEOUT_SECS)),
    )
    .map_err(|error| format!("client build failed: {error}"))?;

    let validation = try_media_validation_request(&client, &proxy, validation_url).await?;
    let latency_ms = ((tcp_latency_ms + validation.first_byte_latency_ms) / 2).max(1);

    Ok(ValidatedProxy {
        candidate: proxy.candidate,
        proxy_type,
        latency_ms,
        throughput_kbps: validation.throughput_kbps,
        last_checked_at: now_secs(),
    })
}

struct MediaValidationResult {
    first_byte_latency_ms: u64,
    throughput_kbps: u64,
}

async fn test_proxy_tcp_connect(candidate: &ProxyCandidate) -> Result<u64, String> {
    let started = Instant::now();
    let socket = tokio::time::timeout(
        Duration::from_millis(VALIDATION_TCP_TIMEOUT_MS),
        TcpStream::connect((candidate.host.as_str(), candidate.port)),
    )
    .await
    .map_err(|_| "raw TCP connect timeout".to_string())?
    .map_err(|error| format!("raw TCP connect failed: {error}"))?;

    let latency_ms = started.elapsed().as_millis() as u64;
    let _ = socket.set_nodelay(true);
    drop(socket);
    Ok(latency_ms.max(1))
}

async fn try_media_validation_request(
    client: &Client,
    proxy: &ValidatedProxy,
    validation_url: &str,
) -> Result<MediaValidationResult, String> {
    log_auto_proxy(format!(
        "Starting real track cache validation endpoint={} url={validation_url}",
        proxy.candidate.endpoint_label()
    ));

    let request_started = Instant::now();
    let response = client
        .get(validation_url)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE)
        .header(ACCEPT, "audio/*,*/*;q=0.8")
        .header(RANGE, VALIDATION_MEDIA_RANGE_HEADER)
        .send()
        .await
        .map_err(|error| format!("media request failed: {}", format_reqwest_error(&error)))?;

    let request_latency_ms = request_started.elapsed().as_millis() as u64;
    match proxy.proxy_type {
        MediaProxyType::Socks4 => log_proxy_test("SOCKS4 handshake success"),
        MediaProxyType::Socks5 => log_proxy_test("SOCKS5 handshake success"),
        MediaProxyType::Http => log_proxy_test("HTTP CONNECT established"),
        MediaProxyType::Https => log_proxy_test("HTTPS CONNECT established"),
    }

    if !(response.status().is_success() || response.status() == StatusCode::PARTIAL_CONTENT) {
        return Err(format!("media HTTP {}", response.status()));
    }

    let mut bytes_stream = response.bytes_stream();
    let stream_started = Instant::now();
    let mut first_chunk_latency_ms = None;
    let mut total_bytes = 0usize;

    while let Some(chunk) = bytes_stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("media chunk read failed: {}", format_reqwest_error(&error)))?;
        if first_chunk_latency_ms.is_none() {
            let first_byte = stream_started.elapsed().as_millis() as u64;
            first_chunk_latency_ms = Some(first_byte.max(1));
            log_proxy_test("TLS established");
        }
        total_bytes += chunk.len();
        if total_bytes > 0 {
            log_auto_proxy("Cache progressing...");
        }
        if total_bytes >= VALIDATION_TARGET_MEDIA_BYTES || total_bytes >= VALIDATION_MIN_MEDIA_BYTES
        {
            break;
        }
    }

    if total_bytes < VALIDATION_MIN_MEDIA_BYTES {
        return Err(format!(
            "cache did not progress enough: {} bytes",
            total_bytes
        ));
    }

    let fetch_elapsed = stream_started.elapsed().as_secs_f64().max(0.001);
    let throughput_kbps = ((total_bytes as f64 * 8.0) / fetch_elapsed / 1000.0).round() as u64;
    log_proxy_test("Audio range request success");
    log_proxy_test(format!(
        "First media chunk fetched ({}kb)",
        (total_bytes / 1024).max(1)
    ));
    log_proxy_test("Proxy accepted for playback");
    log_auto_proxy("Proxy accepted for real streaming");

    Ok(MediaValidationResult {
        first_byte_latency_ms: first_chunk_latency_ms.unwrap_or(request_latency_ms.max(1)),
        throughput_kbps: throughput_kbps.max(1),
    })
}

async fn validate_auto_source(
    state: &MediaProxyState,
    candidates: Vec<ProxyCandidate>,
    scan_epoch: u64,
    source_label: &'static str,
    exclude_key: &str,
    blacklisted_endpoints: &HashSet<String>,
    validation_url: Option<&str>,
) -> (Option<ValidatedProxy>, usize) {
    if candidates.is_empty() {
        log_auto_proxy(format!("No proxies to validate from {source_label}"));
        return (None, 0);
    }

    let available = candidates
        .into_iter()
        .filter(|candidate| {
            let blacklisted = blacklisted_endpoints.contains(&candidate.endpoint_key());
            if blacklisted {
                log_auto_proxy(format!(
                    "Skipping blacklisted endpoint {} source={}",
                    candidate.endpoint_label(),
                    candidate.source
                ));
            }
            !blacklisted
        })
        .take(AUTO_MAX_CANDIDATES)
        .collect::<Vec<_>>();

    let pool_size = available.len();
    if validation_url.is_none() {
        log_auto_proxy(
            "No remembered media URL available yet; auto proxy selection deferred until real playback/cache traffic exists",
        );
        return (None, pool_size);
    }

    for candidate in available {
        if !state.is_auto_scan_epoch_active(scan_epoch) {
            return (None, pool_size);
        }
        if let Some(proxy) =
            validate_proxy_candidate(state, candidate, scan_epoch, validation_url, false).await
        {
            if !exclude_key.is_empty() && proxy.cache_key() == exclude_key {
                log_auto_proxy(format!(
                    "Skipping excluded proxy {}",
                    proxy.candidate.endpoint_label()
                ));
                continue;
            }

            log_auto_proxy(format!(
                "Validated working proxy from {}",
                source_label
            ));
            return (Some(proxy), pool_size);
        }
    }

    log_auto_proxy(format!(
        "No working proxies accepted from {}",
        source_label
    ));
    (None, pool_size)
}

fn looks_like_media_stream_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("sndcdn.com/")
        || lower.contains("/media/")
        || lower.contains("/stream/")
        || lower.contains(".mp3")
        || lower.contains(".m4a")
        || lower.contains(".aac")
        || lower.contains(".ogg")
        || lower.contains(".opus")
        || lower.contains(".m3u8")
}






