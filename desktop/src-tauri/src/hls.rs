use reqwest::{Client, Response, Url};

const MAX_HLS_PLAYLIST_DEPTH: usize = 4;

#[derive(Debug, Clone)]
pub struct HlsMediaPlaylist {
    pub playlist_url: String,
    pub init_segment_url: Option<String>,
    pub segment_urls: Vec<String>,
}

#[derive(Debug)]
struct VariantStream {
    url: String,
    bandwidth: u64,
    codecs: Option<String>,
}

pub fn response_is_hls(response: &Response, url: &str) -> bool {
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let normalized_url = url.to_ascii_lowercase();

    content_type.contains("mpegurl")
        || content_type.contains("vnd.apple")
        || normalized_url.contains(".m3u8")
}

pub async fn resolve_media_playlist(
    client: &Client,
    response: Response,
    source_url: &str,
) -> Result<HlsMediaPlaylist, String> {
    let mut playlist_url = source_url.to_string();
    let mut playlist_text = response
        .text()
        .await
        .map_err(|error| format!("Failed to read HLS playlist: {error}"))?;

    for depth in 0..=MAX_HLS_PLAYLIST_DEPTH {
        let Some(next_variant_url) = select_best_variant_url(&playlist_text, &playlist_url)? else {
            return parse_media_playlist(&playlist_text, &playlist_url);
        };

        if depth == MAX_HLS_PLAYLIST_DEPTH {
            return Err("HLS playlist nesting is too deep".to_string());
        }

        let variant_response = client
            .get(&next_variant_url)
            .send()
            .await
            .map_err(|error| format!("Failed to fetch HLS variant playlist: {error}"))?;

        if !variant_response.status().is_success() {
            let status = variant_response.status();
            let body = variant_response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!(
                "Failed to fetch HLS variant playlist: {status} - {body}"
            ));
        }

        playlist_url = next_variant_url;
        playlist_text = variant_response
            .text()
            .await
            .map_err(|error| format!("Failed to read HLS variant playlist: {error}"))?;
    }

    Err("HLS playlist nesting is too deep".to_string())
}

fn select_best_variant_url(
    playlist_text: &str,
    playlist_url: &str,
) -> Result<Option<String>, String> {
    let mut variants = Vec::new();
    let mut pending_bandwidth = 0u64;
    let mut pending_codecs = None;
    let mut awaiting_uri = false;

    for raw_line in playlist_text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_bandwidth = parse_numeric_attribute(attributes, "BANDWIDTH").unwrap_or(0);
            pending_codecs = parse_quoted_attribute(attributes, "CODECS");
            awaiting_uri = true;
            continue;
        }

        if awaiting_uri {
            if line.starts_with('#') {
                continue;
            }

            variants.push(VariantStream {
                url: resolve_playlist_url(line, playlist_url)?,
                bandwidth: pending_bandwidth,
                codecs: pending_codecs.take(),
            });
            awaiting_uri = false;
        }
    }

    if variants.is_empty() {
        return Ok(None);
    }

    variants.sort_by_key(|variant| {
        let codec_score = variant
            .codecs
            .as_deref()
            .map(|codecs| codecs.to_ascii_lowercase())
            .map(|codecs| {
                if codecs.contains("mp4a") || codecs.contains("aac") {
                    3u8
                } else if codecs.contains("mp3") {
                    2u8
                } else if codecs.contains("opus") {
                    1u8
                } else {
                    0u8
                }
            })
            .unwrap_or(0);

        (codec_score, variant.bandwidth)
    });

    Ok(variants.pop().map(|variant| variant.url))
}

fn parse_media_playlist(
    playlist_text: &str,
    playlist_url: &str,
) -> Result<HlsMediaPlaylist, String> {
    let mut init_segment_url = None;
    let mut segment_urls = Vec::new();

    for raw_line in playlist_text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(attributes) = line.strip_prefix("#EXT-X-KEY:") {
            let method = parse_attribute(attributes, "METHOD")
                .unwrap_or_else(|| "NONE".to_string())
                .to_ascii_uppercase();
            if method != "NONE" {
                return Err("Encrypted HLS streams are not supported".to_string());
            }
            continue;
        }

        if let Some(attributes) = line.strip_prefix("#EXT-X-MAP:") {
            if let Some(uri) = parse_quoted_attribute(attributes, "URI") {
                init_segment_url = Some(resolve_playlist_url(&uri, playlist_url)?);
            }
            continue;
        }

        if line.starts_with('#') {
            continue;
        }

        segment_urls.push(resolve_playlist_url(line, playlist_url)?);
    }

    if segment_urls.is_empty() {
        return Err("HLS playlist has no media segments".to_string());
    }

    Ok(HlsMediaPlaylist {
        playlist_url: playlist_url.to_string(),
        init_segment_url,
        segment_urls,
    })
}

fn resolve_playlist_url(raw: &str, playlist_url: &str) -> Result<String, String> {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(raw.to_string());
    }

    let base = Url::parse(playlist_url)
        .map_err(|error| format!("Invalid HLS playlist URL {playlist_url}: {error}"))?;
    base.join(raw)
        .map(|url| url.to_string())
        .map_err(|error| format!("Failed to resolve HLS segment URL {raw}: {error}"))
}

fn parse_quoted_attribute(attributes: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = attributes.find(&needle)? + needle.len();
    let rest = &attributes[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_numeric_attribute(attributes: &str, key: &str) -> Option<u64> {
    parse_attribute(attributes, key)?.parse::<u64>().ok()
}

fn parse_attribute(attributes: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let start = attributes.find(&needle)? + needle.len();
    let rest = &attributes[start..];
    let value = rest.split(',').next()?.trim();
    Some(value.trim_matches('"').to_string())
}
