use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::oneshot;
use url::Url;

const SOUNDCLOUD_API_BASE: &str = "https://api.soundcloud.com";
const SOUNDCLOUD_AUTHORIZE_URL: &str = "https://secure.soundcloud.com/authorize";
const SOUNDCLOUD_TOKEN_URL: &str = "https://secure.soundcloud.com/oauth/token";
const SOUNDCLOUD_DESKTOP_SCHEME: &str = "soundcloud-desktop";
const SOUNDCLOUD_REDIRECT_URI: &str = "https://sc-auth-redirect.web.app/oauth/callback";

#[derive(Default)]
pub struct OAuthCallbackState {
    pending: Mutex<Option<oneshot::Sender<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundCloudToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub token_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct ScTrack {
    pub id: i64,
    pub title: String,
    pub duration: i32,
    pub uri: String,
    pub access: String,
    pub media: Option<ScMedia>,
    #[serde(default)]
    pub stream_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct ScMedia {
    pub transcodings: Vec<ScTranscoding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct ScTranscoding {
    pub url: String,
    pub preset: Option<String>,
    pub snipped: Option<bool>,
    pub format: Option<ScFormat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct ScFormat {
    pub protocol: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct ScStreams {
    pub http_mp3_128_url: Option<String>,
    pub hls_mp3_128_url: Option<String>,
    pub hls_aac_160_url: Option<String>,
    pub hls_aac_96_url: Option<String>,
    pub hls_opus_64_url: Option<String>,
    pub preview_mp3_128_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct TranscodingUrlResponse {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(crate = "serde")]
struct TrackStreamUrlPayload {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub http_mp3_128_url: Option<String>,
    #[serde(default)]
    pub hls_mp3_128_url: Option<String>,
    #[serde(default)]
    pub hls_aac_160_url: Option<String>,
    #[serde(default)]
    pub hls_aac_96_url: Option<String>,
    #[serde(default)]
    pub hls_opus_64_url: Option<String>,
    #[serde(default)]
    pub preview_mp3_128_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct ResolvedTrackStream {
    pub url: String,
    pub format: String,
    pub protocol: String,
    pub mime_type: String,
    pub quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "serde")]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    #[serde(default)]
    pub urn: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub permalink_url: Option<String>,
    #[serde(default)]
    pub followers_count: Option<i32>,
    #[serde(default)]
    pub followings_count: Option<i32>,
    #[serde(default)]
    pub track_count: Option<i32>,
    #[serde(default)]
    pub playlist_count: Option<i32>,
    #[serde(default)]
    pub public_favorites_count: Option<i32>,
}

#[derive(Debug)]
struct OAuthCallbackPayload {
    code: String,
    state: String,
}

pub struct DirectSoundCloudApi {
    client: Client,
    redirectless_client: Client,
}

impl DirectSoundCloudApi {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            redirectless_client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("failed to build redirectless SoundCloud client"),
        }
    }

    fn oauth_authorization(token: &str) -> String {
        format!("OAuth {token}")
    }

    pub async fn start_oauth(
        client_id: String,
        client_secret: String,
        locale: String,
        app: AppHandle,
    ) -> Result<SoundCloudToken, String> {
        let verifier = generate_pkce_verifier();
        let challenge = pkce_challenge(&verifier);
        let state = format!(
            "{}.{}",
            generate_random_hex(16),
            normalize_oauth_locale(&locale)
        );
        let callback_url = Self::wait_for_oauth_callback(&app)?;

        let authorize_url = format!(
            "{SOUNDCLOUD_AUTHORIZE_URL}?client_id={}&redirect_uri={}&response_type=code&state={}&code_challenge={}&code_challenge_method=S256",
            urlencoding::encode(&client_id),
            urlencoding::encode(SOUNDCLOUD_REDIRECT_URI),
            urlencoding::encode(&state),
            urlencoding::encode(&challenge),
        );

        if let Err(error) = tauri_plugin_opener::open_url(&authorize_url, None::<&str>) {
            clear_pending_callback(&app);
            return Err(format!("Failed to open browser: {error}"));
        }

        let callback_url = match tokio::time::timeout(Duration::from_secs(300), callback_url).await
        {
            Ok(Ok(url)) => url,
            Ok(Err(_)) => {
                clear_pending_callback(&app);
                return Err("OAuth callback channel closed".to_string());
            }
            Err(_) => {
                clear_pending_callback(&app);
                return Err("OAuth callback timeout (5 minutes)".to_string());
            }
        };

        let payload = parse_oauth_callback(&callback_url)?;
        if payload.state != state {
            return Err("OAuth state mismatch".to_string());
        }

        Self::exchange_code_for_token(
            &payload.code,
            SOUNDCLOUD_REDIRECT_URI,
            &client_id,
            &client_secret,
            &verifier,
        )
        .await
    }

    fn wait_for_oauth_callback(app: &AppHandle) -> Result<oneshot::Receiver<String>, String> {
        let state = app.state::<OAuthCallbackState>();
        let (tx, rx) = oneshot::channel::<String>();
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "Failed to lock OAuth callback state".to_string())?;

        if pending.is_some() {
            return Err("SoundCloud OAuth is already in progress".to_string());
        }

        *pending = Some(tx);
        Ok(rx)
    }

    async fn exchange_code_for_token(
        code: &str,
        redirect_uri: &str,
        client_id: &str,
        client_secret: &str,
        code_verifier: &str,
    ) -> Result<SoundCloudToken, String> {
        let response = Client::new()
            .post(SOUNDCLOUD_TOKEN_URL)
            .header("accept", "application/json; charset=utf-8")
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("grant_type", "authorization_code"),
                ("redirect_uri", redirect_uri),
                ("code", code),
                ("code_verifier", code_verifier),
            ])
            .send()
            .await
            .map_err(|error| format!("Token exchange request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Token exchange failed with {status}: {body}"));
        }

        response
            .json::<SoundCloudToken>()
            .await
            .map_err(|error| format!("Failed to parse token response: {error}"))
    }

    async fn refresh_token(
        refresh_token: &str,
        client_id: &str,
        client_secret: &str,
    ) -> Result<SoundCloudToken, String> {
        let response = Client::new()
            .post(SOUNDCLOUD_TOKEN_URL)
            .header("accept", "application/json; charset=utf-8")
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .send()
            .await
            .map_err(|error| format!("Token refresh request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Token refresh failed with {status}: {body}"));
        }

        response
            .json::<SoundCloudToken>()
            .await
            .map_err(|error| format!("Failed to parse refresh response: {error}"))
    }

    pub async fn get_track_stream(
        &self,
        track_id: &str,
        token: &str,
    ) -> Result<ResolvedTrackStream, String> {
        let track_urn = if track_id.starts_with("soundcloud:tracks:") {
            track_id.to_string()
        } else {
            format!("soundcloud:tracks:{track_id}")
        };

        let track = self.fetch_track(&track_urn, token).await?;

        if track.access == "blocked" {
            return Err("Track is blocked".to_string());
        }

        if let Ok(stream) = self
            .resolve_track_stream_pass(token, &track, &track_urn, false)
            .await
        {
            return Ok(stream);
        }

        if let Ok(stream) = self
            .resolve_track_stream_pass(token, &track, &track_urn, true)
            .await
        {
            return Ok(stream);
        }

        Err("No direct SoundCloud stream available for this track".to_string())
    }

    pub async fn get_cdn_stream_url(&self, track_id: &str, token: &str) -> Result<String, String> {
        self.get_track_stream(track_id, token)
            .await
            .map(|stream| stream.url)
    }

    async fn resolve_track_stream_pass(
        &self,
        token: &str,
        track: &ScTrack,
        track_urn: &str,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        if let Some(media) = &track.media {
            if let Ok(stream) = self
                .get_progressive_mp3_from_transcodings(token, media, allow_preview)
                .await
            {
                return Ok(stream);
            }

            if let Ok(stream) = self
                .get_hls_from_transcodings(token, media, allow_preview)
                .await
            {
                return Ok(stream);
            }
        }

        match self
            .get_stream_from_streams(token, track_urn, allow_preview)
            .await
        {
            Ok(stream) => Ok(stream),
            Err(streams_error) if allow_preview => self
                .get_stream_from_track_stream_url(token, track, true)
                .await
                .map_err(|track_stream_error| {
                    format!("{streams_error}; track stream_url fallback: {track_stream_error}")
                }),
            Err(streams_error) => Err(streams_error),
        }
    }

    async fn fetch_track(&self, track_urn: &str, token: &str) -> Result<ScTrack, String> {
        let response = self
            .client
            .get(format!("{SOUNDCLOUD_API_BASE}/tracks/{track_urn}"))
            .header("Authorization", Self::oauth_authorization(token))
            .header("Accept", "application/json; charset=utf-8")
            .send()
            .await
            .map_err(|error| format!("Failed to fetch track: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Failed to fetch track: {status} - {body}"));
        }

        response
            .json::<ScTrack>()
            .await
            .map_err(|error| format!("Failed to parse track response: {error}"))
    }

    async fn get_progressive_mp3_from_transcodings(
        &self,
        token: &str,
        media: &ScMedia,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        let transcodings = rank_progressive_mp3_transcodings(&media.transcodings, allow_preview);

        for transcoding in transcodings {
            if let Ok(stream) = self
                .resolve_transcoding_stream(token, &transcoding, allow_preview)
                .await
            {
                return Ok(stream);
            }
        }

        Err("No progressive MP3 transcoding found".to_string())
    }

    async fn get_hls_from_transcodings(
        &self,
        token: &str,
        media: &ScMedia,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        let transcodings = rank_hls_transcodings(&media.transcodings, allow_preview);

        for transcoding in transcodings {
            if let Ok(stream) = self
                .resolve_transcoding_stream(token, &transcoding, allow_preview)
                .await
            {
                return Ok(stream);
            }
        }

        Err("No HLS transcoding found".to_string())
    }

    async fn resolve_transcoding_url(
        &self,
        token: &str,
        transcoding_url: &str,
    ) -> Result<String, String> {
        let response = self
            .redirectless_client
            .get(transcoding_url)
            .header("Authorization", Self::oauth_authorization(token))
            .header("Accept", "application/json; charset=utf-8")
            .send()
            .await
            .map_err(|error| format!("Failed to resolve transcoding: {error}"))?;

        if response.status().is_redirection() {
            if let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.trim().is_empty())
            {
                return Ok(location.to_string());
            }

            return Err("Transcoding redirect has no location header".to_string());
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Failed to resolve transcoding: {status} - {body}"));
        }

        let payload = response
            .json::<TranscodingUrlResponse>()
            .await
            .map_err(|error| format!("Failed to parse transcoding response: {error}"))?;

        payload
            .location
            .or(payload.url)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Transcoding resolver returned no stream URL".to_string())
    }

    async fn resolve_transcoding_stream(
        &self,
        token: &str,
        transcoding: &ScTranscoding,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        let url = self
            .resolve_transcoding_url(token, &transcoding.url)
            .await?;
        if !allow_preview && is_preview_stream_url(&url) {
            return Err("Resolved transcoding points to preview stream".to_string());
        }
        Ok(ResolvedTrackStream {
            url,
            format: normalize_stream_format(transcoding),
            protocol: normalize_transcoding_protocol(transcoding),
            mime_type: infer_transcoding_mime_type(transcoding),
            quality: infer_stream_quality(transcoding),
        })
    }

    async fn get_stream_from_streams(
        &self,
        token: &str,
        track_urn: &str,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        let response = self
            .client
            .get(format!("{SOUNDCLOUD_API_BASE}/tracks/{track_urn}/streams"))
            .header("Authorization", Self::oauth_authorization(token))
            .header("Accept", "application/json; charset=utf-8")
            .send()
            .await
            .map_err(|error| format!("Failed to fetch streams: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Failed to fetch streams: {status} - {body}"));
        }

        let streams = response
            .json::<ScStreams>()
            .await
            .map_err(|error| format!("Failed to parse streams response: {error}"))?;

        self.resolve_stream_candidates(token, &streams, allow_preview)
            .await
            .map_err(|error| format!("Failed to resolve /streams URL: {error}"))
    }

    async fn get_stream_from_track_stream_url(
        &self,
        token: &str,
        track: &ScTrack,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        let stream_url = track
            .stream_url
            .as_deref()
            .ok_or_else(|| "Track has no stream_url fallback".to_string())?;

        let response = self
            .redirectless_client
            .get(stream_url)
            .header("Authorization", Self::oauth_authorization(token))
            .header("Accept", "application/json; charset=utf-8")
            .send()
            .await
            .map_err(|error| format!("Failed to fetch track stream_url: {error}"))?;

        if response.status().is_redirection() {
            if let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.trim().is_empty())
            {
                if !allow_preview && is_preview_stream_url(location) {
                    return Err("Track stream_url redirect points to preview stream".to_string());
                }
                return Ok(ResolvedTrackStream {
                    url: location.to_string(),
                    format: "http_mp3_128".to_string(),
                    protocol: "progressive".to_string(),
                    mime_type: "audio/mpeg".to_string(),
                    quality: "lq".to_string(),
                });
            }

            return Err("Track stream_url redirect has no location header".to_string());
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!(
                "Track stream_url fallback failed: {status} - {body}"
            ));
        }

        if let Some(location) = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
        {
            if !allow_preview && is_preview_stream_url(location) {
                return Err("Track stream_url location points to preview stream".to_string());
            }
            return Ok(ResolvedTrackStream {
                url: location.to_string(),
                format: "http_mp3_128".to_string(),
                protocol: "progressive".to_string(),
                mime_type: "audio/mpeg".to_string(),
                quality: "lq".to_string(),
            });
        }

        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read track stream_url payload: {error}"))?;

        let payload = serde_json::from_str::<TrackStreamUrlPayload>(&body)
            .map_err(|error| format!("Failed to parse track stream_url payload: {error}"))?;

        if let Some(url) = payload
            .location
            .clone()
            .or(payload.url.clone())
            .filter(|value| !value.trim().is_empty())
        {
            if !allow_preview && is_preview_stream_url(&url) {
                return Err("Track stream_url payload points to preview stream".to_string());
            }
            return Ok(ResolvedTrackStream {
                url,
                format: "http_mp3_128".to_string(),
                protocol: "progressive".to_string(),
                mime_type: "audio/mpeg".to_string(),
                quality: "lq".to_string(),
            });
        }

        self.resolve_stream_candidates(
            token,
            &ScStreams {
                http_mp3_128_url: payload.http_mp3_128_url,
                hls_mp3_128_url: payload.hls_mp3_128_url,
                hls_aac_160_url: payload.hls_aac_160_url,
                hls_aac_96_url: payload.hls_aac_96_url,
                hls_opus_64_url: payload.hls_opus_64_url,
                preview_mp3_128_url: payload.preview_mp3_128_url,
            },
            allow_preview,
        )
        .await
    }

    async fn resolve_stream_candidates(
        &self,
        token: &str,
        streams: &ScStreams,
        allow_preview: bool,
    ) -> Result<ResolvedTrackStream, String> {
        let mut candidates = Vec::new();

        if let Some(url) = streams.http_mp3_128_url.clone() {
            candidates.push((
                url,
                "http_mp3_128".to_string(),
                "progressive".to_string(),
                "audio/mpeg".to_string(),
                "lq".to_string(),
            ));
        }

        if let Some(url) = streams
            .hls_aac_160_url
            .clone()
            .or(streams.hls_aac_96_url.clone())
        {
            candidates.push((
                url,
                "hls_aac_160".to_string(),
                "hls".to_string(),
                "audio/mp4; codecs=\"mp4a.40.2\"".to_string(),
                "hq".to_string(),
            ));
        }

        if let Some(url) = streams.hls_mp3_128_url.clone() {
            candidates.push((
                url,
                "hls_mp3_128".to_string(),
                "hls".to_string(),
                "audio/mpeg".to_string(),
                "lq".to_string(),
            ));
        }

        if let Some(url) = streams.hls_opus_64_url.clone() {
            candidates.push((
                url,
                "hls_opus_64".to_string(),
                "hls".to_string(),
                "audio/ogg; codecs=\"opus\"".to_string(),
                "lq".to_string(),
            ));
        }

        if allow_preview {
            if let Some(url) = streams.preview_mp3_128_url.clone() {
                candidates.push((
                    url,
                    "http_mp3_128".to_string(),
                    "progressive".to_string(),
                    "audio/mpeg".to_string(),
                    "lq".to_string(),
                ));
            }
        }

        let mut last_error = None;

        for (candidate_url, format, protocol, mime_type, quality) in candidates {
            match self.resolve_transcoding_url(token, &candidate_url).await {
                Ok(url) => {
                    if !allow_preview && is_preview_stream_url(&url) {
                        last_error =
                            Some("Resolved stream candidate points to preview stream".to_string());
                        continue;
                    }
                    return Ok(ResolvedTrackStream {
                        url,
                        format,
                        protocol,
                        mime_type,
                        quality,
                    });
                }
                Err(error) => {
                    if !candidate_url.contains("api.soundcloud.com") {
                        if !allow_preview && is_preview_stream_url(&candidate_url) {
                            last_error = Some(
                                "Direct stream candidate points to preview stream".to_string(),
                            );
                            continue;
                        }
                        return Ok(ResolvedTrackStream {
                            url: candidate_url,
                            format,
                            protocol,
                            mime_type,
                            quality,
                        });
                    }

                    last_error = Some(error);
                }
            }
        }

        if let Some(error) = last_error {
            return Err(error);
        }

        Err("No usable stream candidates were returned".to_string())
    }

    pub async fn fetch_user_info(&self, token: &str) -> Result<UserInfo, String> {
        let response = self
            .client
            .get(format!("{SOUNDCLOUD_API_BASE}/me"))
            .header("Authorization", Self::oauth_authorization(token))
            .header("Accept", "application/json; charset=utf-8")
            .send()
            .await
            .map_err(|error| format!("Failed to fetch user info: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Failed to fetch user info: {status} - {body}"));
        }

        response
            .json::<UserInfo>()
            .await
            .map_err(|error| format!("Failed to parse user info: {error}"))
    }
}

pub fn init_deep_link(app: &AppHandle) -> Result<(), String> {
    app.deep_link()
        .register_all()
        .map_err(|error| format!("Failed to register deep links: {error}"))?;

    let app_handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            forward_oauth_callback(&app_handle, url.as_str());
        }
    });

    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            forward_oauth_callback(app, url.as_str());
        }
    }

    Ok(())
}

fn clear_pending_callback(app: &AppHandle) {
    let state = app.state::<OAuthCallbackState>();
    if let Ok(mut pending) = state.pending.lock() {
        pending.take();
    };
}

fn forward_oauth_callback(app: &AppHandle, url: &str) {
    if !url.starts_with(&format!("{SOUNDCLOUD_DESKTOP_SCHEME}://")) {
        return;
    }

    let state = app.state::<OAuthCallbackState>();
    let Ok(mut pending) = state.pending.lock() else {
        return;
    };
    let Some(sender) = pending.take() else {
        return;
    };
    let _ = sender.send(url.to_string());
}

fn generate_pkce_verifier() -> String {
    let mut bytes = [0u8; 32];
    for byte in &mut bytes {
        *byte = rand::random();
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_random_hex(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    for byte in &mut bytes {
        *byte = rand::random();
    }
    hex::encode(bytes)
}

fn normalize_oauth_locale(locale: &str) -> &'static str {
    let normalized = locale.trim().to_ascii_lowercase();

    if normalized == "ru-x-rofl" || normalized == "ru-rofl" {
        "ru-x-rofl"
    } else if normalized == "ru" || normalized.starts_with("ru-") {
        "ru"
    } else {
        "en"
    }
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};

    let hash = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

fn parse_oauth_callback(callback_url: &str) -> Result<OAuthCallbackPayload, String> {
    let parsed =
        Url::parse(callback_url).map_err(|error| format!("Invalid callback URL: {error}"))?;

    if parsed.scheme() != SOUNDCLOUD_DESKTOP_SCHEME {
        return Err("Unexpected OAuth callback scheme".to_string());
    }

    if parsed.host_str() != Some("oauth") || parsed.path() != "/callback" {
        return Err("Unexpected OAuth callback path".to_string());
    }

    if let Some(error) = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "error").then(|| value.to_string()))
    {
        return Err(format!("SoundCloud OAuth failed: {error}"));
    }

    let code = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "code").then(|| value.to_string()))
        .ok_or_else(|| "OAuth callback is missing code".to_string())?;

    let state = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.to_string()))
        .ok_or_else(|| "OAuth callback is missing state".to_string())?;

    Ok(OAuthCallbackPayload { code, state })
}

fn is_preview_stream_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if lower.contains("cf-preview-media.sndcdn.com")
        || lower.contains("preview-media.sndcdn.com")
        || lower.contains("/preview/")
    {
        return true;
    }

    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .map(|host| host.contains("preview-media.sndcdn.com"))
        .unwrap_or(false)
}

fn rank_progressive_mp3_transcodings(
    transcodings: &[ScTranscoding],
    allow_preview: bool,
) -> Vec<ScTranscoding> {
    let mut candidates: Vec<_> = transcodings
        .iter()
        .filter(|transcoding| {
            let protocol = normalize_transcoding_protocol(transcoding);
            let mime_type = transcoding
                .format
                .as_ref()
                .and_then(|format| format.mime_type.as_deref())
                .unwrap_or_default();
            let preset = transcoding.preset.as_deref().unwrap_or_default();
            let is_preview =
                transcoding.url.contains("/preview") || transcoding.snipped == Some(true);

            (protocol == "progressive" || preset.starts_with("http_"))
                && (preset == "http_mp3_128"
                    || preset.starts_with("http_mp3")
                    || mime_type.contains("mpeg")
                    || mime_type.contains("mp3"))
                && (allow_preview || !is_preview)
        })
        .cloned()
        .collect();

    candidates.sort_by_key(|transcoding| {
        let preset = transcoding.preset.as_deref().unwrap_or_default();
        let is_preview = transcoding.url.contains("/preview");
        let mut score = 100;

        if preset == "http_mp3_128" {
            score -= 50;
        }
        if !is_preview {
            score -= 10;
        }

        score
    });

    candidates
}

fn rank_hls_transcodings(
    transcodings: &[ScTranscoding],
    allow_preview: bool,
) -> Vec<ScTranscoding> {
    let mut candidates: Vec<_> = transcodings
        .iter()
        .filter(|transcoding| {
            let protocol = normalize_transcoding_protocol(transcoding);
            let preset = transcoding.preset.as_deref().unwrap_or_default();
            let is_preview =
                transcoding.url.contains("/preview") || transcoding.snipped == Some(true);

            (protocol == "hls" || preset.starts_with("hls_")) && (allow_preview || !is_preview)
        })
        .cloned()
        .collect();

    candidates.sort_by_key(|transcoding| {
        let format = normalize_stream_format(transcoding);
        let is_preview = transcoding.url.contains("/preview") || transcoding.snipped == Some(true);
        let mut score = 100;

        if format == "hls_aac_160" {
            score -= 40;
        } else if format == "hls_mp3_128" {
            score -= 20;
        } else if format == "hls_opus_64" {
            score -= 10;
        }

        if !is_preview {
            score -= 5;
        }

        score
    });

    candidates
}

fn normalize_transcoding_protocol(transcoding: &ScTranscoding) -> String {
    transcoding
        .format
        .as_ref()
        .and_then(|format| format.protocol.as_deref())
        .unwrap_or_else(|| {
            if transcoding.url.contains("/progressive") {
                "progressive"
            } else if transcoding.url.contains("/hls") {
                "hls"
            } else if transcoding
                .preset
                .as_deref()
                .unwrap_or_default()
                .starts_with("http_")
            {
                "progressive"
            } else if transcoding
                .preset
                .as_deref()
                .unwrap_or_default()
                .starts_with("hls_")
            {
                "hls"
            } else {
                ""
            }
        })
        .to_string()
}

fn infer_transcoding_mime_type(transcoding: &ScTranscoding) -> String {
    if let Some(mime_type) = transcoding
        .format
        .as_ref()
        .and_then(|format| format.mime_type.as_deref())
        .filter(|mime_type| !mime_type.trim().is_empty())
    {
        return mime_type.to_string();
    }

    let preset = transcoding.preset.as_deref().unwrap_or_default();
    let protocol = normalize_transcoding_protocol(transcoding);

    if protocol == "hls" {
        if preset.contains("opus") {
            return "audio/ogg; codecs=\"opus\"".to_string();
        }
        if preset.contains("aac") {
            return "audio/mp4; codecs=\"mp4a.40.2\"".to_string();
        }
    }

    "audio/mpeg".to_string()
}

fn normalize_stream_format(transcoding: &ScTranscoding) -> String {
    let protocol = normalize_transcoding_protocol(transcoding);
    let preset = transcoding
        .preset
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime_type = infer_transcoding_mime_type(transcoding).to_ascii_lowercase();

    if protocol == "progressive" {
        return "http_mp3_128".to_string();
    }

    if protocol == "hls" {
        if preset.contains("opus") || mime_type.contains("opus") || mime_type.contains("ogg") {
            return "hls_opus_64".to_string();
        }
        if preset.contains("aac") || mime_type.contains("mp4a") || mime_type.contains("audio/mp4") {
            return "hls_aac_160".to_string();
        }
        return "hls_mp3_128".to_string();
    }

    preset
}

fn infer_stream_quality(transcoding: &ScTranscoding) -> String {
    let format = normalize_stream_format(transcoding);
    if format == "hls_aac_160" {
        "hq".to_string()
    } else {
        "lq".to_string()
    }
}

#[tauri::command]
pub async fn soundcloud_oauth_start(
    client_id: String,
    client_secret: String,
    locale: Option<String>,
    app: AppHandle,
) -> Result<SoundCloudToken, String> {
    DirectSoundCloudApi::start_oauth(
        client_id,
        client_secret,
        locale.unwrap_or_else(|| "en".to_string()),
        app,
    )
    .await
}

#[tauri::command]
pub async fn soundcloud_oauth_refresh(
    client_id: String,
    client_secret: String,
    refresh_token: String,
) -> Result<SoundCloudToken, String> {
    DirectSoundCloudApi::refresh_token(&refresh_token, &client_id, &client_secret).await
}

#[tauri::command]
pub async fn get_cdn_stream_url(track_id: String, access_token: String) -> Result<String, String> {
    DirectSoundCloudApi::new()
        .get_cdn_stream_url(&track_id, &access_token)
        .await
}

#[tauri::command]
pub async fn resolve_soundcloud_track_stream(
    track_id: String,
    access_token: String,
) -> Result<ResolvedTrackStream, String> {
    DirectSoundCloudApi::new()
        .get_track_stream(&track_id, &access_token)
        .await
}

#[tauri::command]
pub async fn fetch_soundcloud_me(access_token: String) -> Result<UserInfo, String> {
    DirectSoundCloudApi::new()
        .fetch_user_info(&access_token)
        .await
}
