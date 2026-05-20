use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::num::NonZero;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm1, Hertz, ToHertz, Type, Q_BUTTERWORTH_F64};
use futures_util::StreamExt;
use rodio::mixer::Mixer;
use rodio::source::SeekError;
use rodio::stream::DeviceSinkBuilder;
use rodio::{Decoder, Player, Source};
use rustfft::{num_complex::Complex, FftPlanner};
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "macos"))]
use soundtouch::{Setting as SoundTouchSetting, SoundTouch};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata as SmtcMetadata, MediaPlayback, MediaPosition,
    PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::{File as TokioFile, OpenOptions as TokioOpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::hls::{resolve_media_playlist, response_is_hls};

/* ── Constants ─────────────────────────────────────────────── */

const EQ_BANDS: usize = 10;
const EQ_FREQS: [f64; EQ_BANDS] = [
    30.0, 60.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 14000.0,
];
const EQ_Q: f64 = 1.414; // ~1 octave bandwidth for peaking filters
const DEFAULT_TARGET_FPS: u32 = 60;
const FPS_PRESETS: [u32; 4] = [15, 30, 60, 120];
const UNLOCKED_EVENT_FPS: u32 = 144;
const NORMALIZATION_ANALYSIS_SAMPLES: usize = 48_000 * 2 * 30;
const NORMALIZATION_BLOCK_SAMPLES: usize = 48_000;
const NORMALIZATION_TARGET_RMS: f64 = 0.14;
const NORMALIZATION_TARGET_PEAK: f64 = 0.95;
const NORMALIZATION_MAX_BOOST_DB: f64 = 9.0;
const NORMALIZATION_MAX_ATTENUATION_DB: f64 = -8.0;
const NORMALIZATION_CACHE_VERSION: u8 = 2;
const MAX_SEEK_FALLBACK_SOURCE_BYTES: usize = 12 * 1024 * 1024;
const RANGE_SEEK_PREROLL_SECS: f64 = 0.35;
const RANGE_SEEK_ALIGNMENT_BYTES: u64 = 4 * 1024;
const STREAM_CACHE_WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const CROSSFADE_HEADROOM: f32 = 0.88;
const PLAYBACK_RATE_MIN: f32 = 0.5;
const PLAYBACK_RATE_MAX: f32 = 2.0;
const PITCH_SEMITONES_MIN: f32 = -12.0;
const PITCH_SEMITONES_MAX: f32 = 12.0;
const PITCH_SOURCE_INPUT_FRAMES: usize = 1024;
const PITCH_SOURCE_OUTPUT_FRAMES: usize = 2048;
const CACHE_METADATA_EXT: &str = ".meta.json";

type ChannelCount = NonZero<u16>;
type SampleRate = NonZero<u32>;

#[derive(serde::Serialize)]
struct StreamCacheMetadata<'a> {
    quality: &'a str,
    source: &'a str,
    complete: bool,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(serde::Deserialize)]
struct StoredStreamCacheMetadata {
    complete: bool,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

fn complete_stream_cache_exists(final_path: &str) -> bool {
    let file_len = std::fs::metadata(final_path)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() >= 8192)
        .map(|meta| meta.len());
    let Some(file_len) = file_len else {
        return false;
    };

    let metadata_path = format!("{final_path}{CACHE_METADATA_EXT}");
    let Ok(raw) = std::fs::read_to_string(metadata_path) else {
        return false;
    };
    let Ok(metadata) = serde_json::from_str::<StoredStreamCacheMetadata>(&raw) else {
        return false;
    };
    let downloaded_bytes = metadata.downloaded_bytes.unwrap_or(file_len);

    metadata.complete
        && downloaded_bytes >= file_len
        && metadata
            .total_bytes
            .map(|total| downloaded_bytes >= total)
            .unwrap_or(true)
}

async fn write_stream_cache_metadata(
    final_path: &str,
    quality: Option<&str>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let metadata = StreamCacheMetadata {
        quality: if quality == Some("hq") { "hq" } else { "sq" },
        source: "api",
        complete: true,
        downloaded_bytes,
        total_bytes,
    };

    let Ok(raw) = serde_json::to_vec(&metadata) else {
        return;
    };

    let final_metadata_path = format!("{final_path}{CACHE_METADATA_EXT}");
    let temp_metadata_path = format!("{final_metadata_path}.tmp");

    if tokio::fs::write(&temp_metadata_path, raw).await.is_err() {
        tokio::fs::remove_file(&temp_metadata_path).await.ok();
        return;
    }

    if tokio::fs::rename(&temp_metadata_path, &final_metadata_path)
        .await
        .is_err()
    {
        tokio::fs::remove_file(&temp_metadata_path).await.ok();
    }
}

/* ── EQ Parameters (shared between audio thread and commands) ─ */

pub struct EqParams {
    pub enabled: bool,
    pub gains: [f64; EQ_BANDS], // dB, -12 to +12
}

impl Default for EqParams {
    fn default() -> Self {
        Self {
            enabled: false,
            gains: [0.0; EQ_BANDS],
        }
    }
}

pub struct PitchParams {
    pub semitones: f32,
    pub playback_rate: f32,
}

impl Default for PitchParams {
    fn default() -> Self {
        Self {
            semitones: 0.0,
            playback_rate: 1.0,
        }
    }
}

/* ── EQ Source wrapper ─────────────────────────────────────── */

struct EqSource<S: Source<Item = f32>> {
    source: S,
    params: Arc<RwLock<EqParams>>,
    filters_l: [DirectForm1<f64>; EQ_BANDS],
    filters_r: [DirectForm1<f64>; EQ_BANDS],
    channels: ChannelCount,
    sample_rate: SampleRate,
    current_channel: u16,
    // Cached gains to detect changes and recompute coefficients
    cached_gains: [f64; EQ_BANDS],
    cached_enabled: bool,
}

impl<S: Source<Item = f32>> EqSource<S> {
    fn new(source: S, params: Arc<RwLock<EqParams>>) -> Self {
        let sample_rate = source.sample_rate();
        let channels = source.channels();
        let fs: Hertz<f64> = (sample_rate.get() as f64).hz();

        let make_filters = || {
            std::array::from_fn(|i| {
                let filter_type = if i == 0 {
                    Type::LowShelf(0.0)
                } else if i == EQ_BANDS - 1 {
                    Type::HighShelf(0.0)
                } else {
                    Type::PeakingEQ(0.0)
                };
                let q = if i == 0 || i == EQ_BANDS - 1 {
                    Q_BUTTERWORTH_F64
                } else {
                    EQ_Q
                };
                let coeffs =
                    Coefficients::<f64>::from_params(filter_type, fs, EQ_FREQS[i].hz(), q).unwrap();
                DirectForm1::<f64>::new(coeffs)
            })
        };

        Self {
            source,
            params,
            filters_l: make_filters(),
            filters_r: make_filters(),
            channels,
            sample_rate,
            current_channel: 0,
            cached_gains: [0.0; EQ_BANDS],
            cached_enabled: false,
        }
    }

    fn update_coefficients(&mut self, gains: &[f64; EQ_BANDS]) {
        let fs: Hertz<f64> = (self.sample_rate.get() as f64).hz();
        for i in 0..EQ_BANDS {
            if (gains[i] - self.cached_gains[i]).abs() < 0.01 {
                continue;
            }
            let filter_type = if i == 0 {
                Type::LowShelf(gains[i])
            } else if i == EQ_BANDS - 1 {
                Type::HighShelf(gains[i])
            } else {
                Type::PeakingEQ(gains[i])
            };
            let q = if i == 0 || i == EQ_BANDS - 1 {
                Q_BUTTERWORTH_F64
            } else {
                EQ_Q
            };
            if let Ok(coeffs) =
                Coefficients::<f64>::from_params(filter_type, fs, EQ_FREQS[i].hz(), q)
            {
                self.filters_l[i] = DirectForm1::<f64>::new(coeffs);
                self.filters_r[i] = DirectForm1::<f64>::new(coeffs);
            }
        }
        self.cached_gains = *gains;
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        let ch = self.current_channel;
        self.current_channel = (ch + 1) % self.channels.get();

        // Read EQ params (non-blocking — skip if locked)
        let snapshot = self.params.try_read().ok().map(|p| (p.enabled, p.gains));
        if let Some((enabled, gains)) = snapshot {
            if enabled != self.cached_enabled || gains != self.cached_gains {
                if enabled {
                    self.update_coefficients(&gains);
                }
                self.cached_enabled = enabled;
            }
        }

        if !self.cached_enabled {
            return Some(sample);
        }

        let mut out = sample as f64;
        let filters = if ch == 0 {
            &mut self.filters_l
        } else {
            &mut self.filters_r
        };
        for f in filters.iter_mut() {
            out = Biquad::run(f, out);
        }
        Some(out.clamp(-1.0, 1.0) as f32)
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

struct GainSource<S: Source<Item = f32>> {
    source: S,
    gain: f32,
}

impl<S: Source<Item = f32>> GainSource<S> {
    fn new(source: S, gain: f32) -> Self {
        Self { source, gain }
    }
}

impl<S: Source<Item = f32>> Iterator for GainSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        self.source
            .next()
            .map(|sample| (sample * self.gain).clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for GainSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

#[cfg(not(target_os = "macos"))]
struct PitchSource<S: Source<Item = f32>> {
    source: S,
    params: Arc<RwLock<PitchParams>>,
    soundtouch: SoundTouch,
    channels: ChannelCount,
    sample_rate: SampleRate,
    current_semitones: f32,
    current_playback_rate: f32,
    input_buffer: Vec<f32>,
    output_buffer: Vec<f32>,
    output_pos: usize,
    source_finished: bool,
    flushed: bool,
}

#[cfg(not(target_os = "macos"))]
impl<S: Source<Item = f32>> PitchSource<S> {
    fn new(source: S, params: Arc<RwLock<PitchParams>>) -> Self {
        let channels = source.channels();
        let sample_rate = source.sample_rate();
        let (initial_semitones, initial_playback_rate) = params
            .try_read()
            .ok()
            .map(|pitch| (pitch.semitones, pitch.playback_rate))
            .unwrap_or((0.0, 1.0));

        let mut soundtouch = SoundTouch::new();
        soundtouch
            .set_channels(channels.get() as u32)
            .set_sample_rate(sample_rate.get())
            .set_tempo(initial_playback_rate as f64)
            .set_pitch(pitch_ratio_from_semitones(initial_semitones))
            .set_setting(SoundTouchSetting::UseQuickseek, 1)
            .set_setting(SoundTouchSetting::UseAaFilter, 1);

        Self {
            source,
            params,
            soundtouch,
            channels,
            sample_rate,
            current_semitones: initial_semitones,
            current_playback_rate: initial_playback_rate,
            input_buffer: Vec::with_capacity(PITCH_SOURCE_INPUT_FRAMES * channels.get() as usize),
            output_buffer: Vec::with_capacity(PITCH_SOURCE_OUTPUT_FRAMES * channels.get() as usize),
            output_pos: 0,
            source_finished: false,
            flushed: false,
        }
    }

    fn reset_processing_state(&mut self) {
        self.soundtouch.clear();
        self.input_buffer.clear();
        self.output_buffer.clear();
        self.output_pos = 0;
        self.flushed = false;
    }

    fn refresh_processing_params(&mut self) {
        let (next_semitones, next_playback_rate) = self
            .params
            .try_read()
            .ok()
            .map(|pitch| (pitch.semitones, pitch.playback_rate))
            .unwrap_or((self.current_semitones, self.current_playback_rate));

        if (next_semitones - self.current_semitones).abs() < 0.001
            && (next_playback_rate - self.current_playback_rate).abs() < 0.001
        {
            return;
        }

        if is_identity_processing(next_playback_rate, next_semitones)
            != is_identity_processing(self.current_playback_rate, self.current_semitones)
        {
            self.reset_processing_state();
        } else {
            self.output_buffer.clear();
            self.output_pos = 0;
        }

        self.soundtouch.set_tempo(next_playback_rate as f64);
        self.soundtouch
            .set_pitch(pitch_ratio_from_semitones(next_semitones));
        self.current_semitones = next_semitones;
        self.current_playback_rate = next_playback_rate;
    }

    fn fill_output_buffer(&mut self) -> bool {
        let channels = self.channels.get() as usize;

        loop {
            self.refresh_processing_params();

            if self.output_pos < self.output_buffer.len() {
                return true;
            }

            self.output_buffer.clear();
            self.output_pos = 0;
            self.output_buffer
                .resize(PITCH_SOURCE_OUTPUT_FRAMES * channels, 0.0);

            let received = self
                .soundtouch
                .receive_samples(&mut self.output_buffer, PITCH_SOURCE_OUTPUT_FRAMES);

            if received > 0 {
                self.output_buffer.truncate(received * channels);
                return true;
            }

            self.output_buffer.clear();

            if self.source_finished {
                if !self.flushed {
                    if self.soundtouch.num_unprocessed_samples() > 0 {
                        self.soundtouch.flush();
                    }
                    self.flushed = true;
                    continue;
                }

                return false;
            }

            self.input_buffer.clear();

            for _ in 0..(PITCH_SOURCE_INPUT_FRAMES * channels) {
                match self.source.next() {
                    Some(sample) => self.input_buffer.push(sample),
                    None => {
                        self.source_finished = true;
                        break;
                    }
                }
            }

            if !self.input_buffer.is_empty() {
                self.soundtouch
                    .put_samples(&self.input_buffer, self.input_buffer.len() / channels);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl<S: Source<Item = f32>> Iterator for PitchSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        self.refresh_processing_params();

        if is_identity_processing(self.current_playback_rate, self.current_semitones) {
            return self.source.next();
        }

        if !self.fill_output_buffer() {
            return None;
        }

        let sample = self.output_buffer.get(self.output_pos).copied();
        self.output_pos += 1;
        sample
    }
}

#[cfg(not(target_os = "macos"))]
impl<S: Source<Item = f32>> Source for PitchSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let playback_rate = self
            .params
            .try_read()
            .ok()
            .map(|pitch| pitch.playback_rate)
            .unwrap_or(self.current_playback_rate);
        let normalized_rate = if playback_rate.is_finite() {
            playback_rate.clamp(PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX)
        } else {
            1.0
        };
        let source_seek_pos =
            Duration::from_secs_f64((pos.as_secs_f64() * normalized_rate as f64).max(0.0));

        self.source.try_seek(source_seek_pos)?;
        self.reset_processing_state();
        self.current_semitones = f32::NAN;
        self.current_playback_rate = f32::NAN;
        self.refresh_processing_params();
        self.source_finished = false;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
struct PitchSource<S: Source<Item = f32>> {
    source: S,
    channels: ChannelCount,
    sample_rate: SampleRate,
}

#[cfg(target_os = "macos")]
impl<S: Source<Item = f32>> PitchSource<S> {
    fn new(source: S, _params: Arc<RwLock<PitchParams>>) -> Self {
        let channels = source.channels();
        let sample_rate = source.sample_rate();
        Self {
            source,
            channels,
            sample_rate,
        }
    }
}

#[cfg(target_os = "macos")]
impl<S: Source<Item = f32>> Iterator for PitchSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        self.source.next()
    }
}

#[cfg(target_os = "macos")]
impl<S: Source<Item = f32>> Source for PitchSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

/* ── Visualizer Source ─────────────────────────────────────── */

const FFT_SIZE: usize = 2048;

struct AnalyzerSource<S: Source<Item = f32>> {
    source: S,
    buffer: Vec<f32>,
    sender: std::sync::mpsc::SyncSender<Vec<f32>>,
}

impl<S: Source<Item = f32>> AnalyzerSource<S> {
    fn new(source: S, sender: std::sync::mpsc::SyncSender<Vec<f32>>) -> Self {
        Self {
            source,
            buffer: Vec::with_capacity(FFT_SIZE),
            sender,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for AnalyzerSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        self.buffer.push(sample);
        if self.buffer.len() >= FFT_SIZE {
            let _ = self.sender.try_send(std::mem::take(&mut self.buffer));
            self.buffer.reserve(FFT_SIZE);
        }
        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for AnalyzerSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.source.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

/* ── OGG/Opus Source ───────────────────────────────────────── */

struct OpusSource {
    reader: ogg::reading::PacketReader<Cursor<Vec<u8>>>,
    decoder: audiopus::coder::Decoder,
    channels: ChannelCount,
    buffer: Vec<f32>,
    buf_pos: usize,
    serial: u32,
    pre_skip: usize,
    samples_skipped: usize,
}

impl OpusSource {
    fn new(data: Vec<u8>) -> Result<Self, String> {
        let mut reader = ogg::reading::PacketReader::new(Cursor::new(data));

        let head_pkt = reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?
            .ok_or("No OpusHead packet")?;

        let head = &head_pkt.data;
        if head.len() < 19 || &head[..8] != b"OpusHead" {
            return Err("Invalid OpusHead".into());
        }

        let serial = head_pkt.stream_serial();
        let ch_count = head[9];
        let pre_skip = u16::from_le_bytes([head[10], head[11]]) as usize;

        let opus_ch = if ch_count == 1 {
            audiopus::Channels::Mono
        } else {
            audiopus::Channels::Stereo
        };

        // Skip OpusTags
        reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?;

        let decoder = audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch)
            .map_err(|e| format!("Opus decoder error: {:?}", e))?;

        let ch = if ch_count == 1 { 1u16 } else { 2u16 };

        Ok(Self {
            reader,
            decoder,
            channels: NonZero::new(ch).unwrap(),
            buffer: Vec::new(),
            buf_pos: 0,
            serial,
            pre_skip: pre_skip * ch as usize,
            samples_skipped: 0,
        })
    }

    fn decode_next_packet(&mut self) -> bool {
        loop {
            match self.reader.read_packet() {
                Ok(Some(pkt)) => {
                    if pkt.data.is_empty() {
                        continue;
                    }
                    let ch = self.channels.get() as usize;
                    let mut buf = vec![0f32; 5760 * ch];
                    match self.decoder.decode_float(Some(&pkt.data), &mut buf, false) {
                        Ok(samples_per_ch) => {
                            let total = samples_per_ch * ch;
                            buf.truncate(total);

                            if self.samples_skipped < self.pre_skip {
                                let skip = (self.pre_skip - self.samples_skipped).min(total);
                                self.samples_skipped += skip;
                                if skip >= total {
                                    continue;
                                }
                                self.buffer = buf[skip..].to_vec();
                            } else {
                                self.buffer = buf;
                            }
                            self.buf_pos = 0;
                            return true;
                        }
                        Err(_) => continue,
                    }
                }
                _ => return false,
            }
        }
    }
}

impl Iterator for OpusSource {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.buf_pos >= self.buffer.len() {
            if !self.decode_next_packet() {
                return None;
            }
        }
        let sample = self.buffer[self.buf_pos];
        self.buf_pos += 1;
        Some(sample)
    }
}

impl Source for OpusSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        NonZero::new(48000).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let target_gp = (pos.as_secs_f64() * 48000.0) as u64;

        match self.reader.seek_absgp(Some(self.serial), target_gp) {
            Ok(_) => {
                let opus_ch = if self.channels.get() == 1 {
                    audiopus::Channels::Mono
                } else {
                    audiopus::Channels::Stereo
                };
                self.decoder =
                    audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch).map_err(
                        |_| SeekError::NotSupported {
                            underlying_source: "opus decoder reinit failed",
                        },
                    )?;
                self.buffer.clear();
                self.buf_pos = 0;
                self.samples_skipped = self.pre_skip;
                Ok(())
            }
            Err(_) => Err(SeekError::NotSupported {
                underlying_source: "ogg seek failed",
            }),
        }
    }
}

/* ── Decode helper ─────────────────────────────────────────── */

fn normalization_cache_file(cache_dir: &Path, cache_key: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    cache_dir.join(format!("{hash}.gain"))
}

fn read_cached_normalization_gain(
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Option<f32> {
    let path = normalization_cache_file(cache_dir?, cache_key?);
    let raw = std::fs::read_to_string(path).ok()?;
    let (version, value) = raw.trim().split_once(':')?;
    if version != NORMALIZATION_CACHE_VERSION.to_string() {
        return None;
    }
    value.parse::<f32>().ok()
}

fn write_cached_normalization_gain(cache_dir: Option<&Path>, cache_key: Option<&str>, gain: f32) {
    let Some(cache_dir) = cache_dir else {
        return;
    };
    let Some(cache_key) = cache_key else {
        return;
    };

    if std::fs::create_dir_all(cache_dir).is_err() {
        return;
    }

    let path = normalization_cache_file(cache_dir, cache_key);
    let _ = std::fs::write(path, format!("{NORMALIZATION_CACHE_VERSION}:{gain:.6}"));
}

fn normalization_gain_from_samples<I>(samples: I) -> f32
where
    I: IntoIterator<Item = f32>,
{
    let mut peak = 0.0f64;
    let mut count = 0usize;
    let mut block_sum_sq = 0.0f64;
    let mut block_count = 0usize;
    let mut block_powers = Vec::new();

    for sample in samples.into_iter().take(NORMALIZATION_ANALYSIS_SAMPLES) {
        let value = sample as f64;
        let abs = value.abs();
        peak = peak.max(abs);
        block_sum_sq += value * value;
        block_count += 1;
        count += 1;

        if block_count >= NORMALIZATION_BLOCK_SAMPLES {
            block_powers.push(block_sum_sq / block_count as f64);
            block_sum_sq = 0.0;
            block_count = 0;
        }
    }

    if block_count > 0 {
        block_powers.push(block_sum_sq / block_count as f64);
    }

    if count == 0 || block_powers.is_empty() {
        return 1.0;
    }

    block_powers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep_from = ((block_powers.len() as f64) * 0.4).floor() as usize;
    let kept = &block_powers[keep_from.min(block_powers.len().saturating_sub(1))..];
    let gated_power = kept.iter().copied().sum::<f64>() / kept.len() as f64;
    let rms = gated_power.sqrt().max(1e-6);
    let target_gain = NORMALIZATION_TARGET_RMS / rms;
    let peak_safe_gain = if peak > 0.0 {
        NORMALIZATION_TARGET_PEAK / peak
    } else {
        target_gain
    };

    let max_boost = 10f64.powf(NORMALIZATION_MAX_BOOST_DB / 20.0);
    let max_attenuation = 10f64.powf(NORMALIZATION_MAX_ATTENUATION_DB / 20.0);
    let gain = target_gain
        .min(peak_safe_gain)
        .clamp(max_attenuation, max_boost);

    if (gain - 1.0).abs() < 0.05 {
        1.0
    } else {
        gain as f32
    }
}

fn resolve_normalization_gain(
    bytes: &[u8],
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Result<f32, String> {
    if let Some(gain) = read_cached_normalization_gain(cache_dir, cache_key) {
        return Ok(gain);
    }

    let gain = if let Ok(source) = Decoder::new(Cursor::new(bytes.to_vec())) {
        normalization_gain_from_samples(source)
    } else {
        normalization_gain_from_samples(
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    };

    write_cached_normalization_gain(cache_dir, cache_key, gain);
    Ok(gain)
}

fn wrap_source_into_player<S>(
    source: S,
    mixer: &Mixer,
    volume: f32,
    playback_speed: f32,
    normalization_gain: f32,
    eq_params: Arc<RwLock<EqParams>>,
    pitch_params: Arc<RwLock<PitchParams>>,
    vis_tx: Option<std::sync::mpsc::SyncSender<Vec<f32>>>,
) -> Result<(Player, Option<f64>), String>
where
    S: Source<Item = f32> + Send + 'static,
{
    let playback_speed = playback_speed.clamp(PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX);
    if let Ok(mut params) = pitch_params.write() {
        params.playback_rate = playback_speed;
    }

    let player = Player::connect_new(mixer);
    player.set_volume(volume.clamp(0.0, 1.0));
    #[cfg(target_os = "macos")]
    player.set_speed(playback_speed);
    #[cfg(not(target_os = "macos"))]
    player.set_speed(1.0);

    let duration = source.total_duration().map(|d| d.as_secs_f64());
    let gain_source = GainSource::new(source, normalization_gain);
    let eq_source = EqSource::new(gain_source, eq_params);
    let pitch_source = PitchSource::new(eq_source, pitch_params.clone());
    if let Some(ref tx) = vis_tx {
        player.append(AnalyzerSource::new(pitch_source, tx.clone()));
    } else {
        player.append(pitch_source);
    }

    Ok((player, duration))
}

fn create_player_from_owned_bytes(
    bytes: Vec<u8>,
    mixer: &Mixer,
    volume: f32,
    playback_speed: f32,
    normalization_gain: f32,
    eq_params: Arc<RwLock<EqParams>>,
    pitch_params: Arc<RwLock<PitchParams>>,
    vis_tx: Option<std::sync::mpsc::SyncSender<Vec<f32>>>,
) -> Result<(Player, Option<f64>), String> {
    if let Ok(source) = Decoder::new(Cursor::new(bytes.clone())) {
        return wrap_source_into_player(
            source,
            mixer,
            volume,
            playback_speed,
            normalization_gain,
            eq_params,
            pitch_params,
            vis_tx,
        );
    }

    let source = OpusSource::new(bytes).map_err(|e| format!("Failed to decode: {}", e))?;
    wrap_source_into_player(
        source,
        mixer,
        volume,
        playback_speed,
        normalization_gain,
        eq_params,
        pitch_params,
        vis_tx,
    )
}

#[derive(Default)]
struct StreamingBufferState {
    bytes: Vec<u8>,
    done: bool,
    error: Option<String>,
}

#[derive(Default)]
struct StreamingBuffer {
    state: Mutex<StreamingBufferState>,
    ready: Condvar,
}

impl StreamingBuffer {
    fn append(&self, chunk: &[u8]) {
        let mut state = self.state.lock().unwrap();
        state.bytes.extend_from_slice(chunk);
        self.ready.notify_all();
    }

    fn finish(&self) {
        let mut state = self.state.lock().unwrap();
        state.done = true;
        self.ready.notify_all();
    }

    fn fail(&self, error: String) {
        let mut state = self.state.lock().unwrap();
        state.error = Some(error);
        state.done = true;
        self.ready.notify_all();
    }

    fn snapshot(&self) -> Vec<u8> {
        self.state.lock().unwrap().bytes.clone()
    }

    fn len(&self) -> usize {
        self.state.lock().unwrap().bytes.len()
    }
}

struct StreamingBufferReader {
    shared: Arc<StreamingBuffer>,
    position: u64,
}

impl StreamingBufferReader {
    fn new(shared: Arc<StreamingBuffer>) -> Self {
        Self::with_position(shared, 0)
    }

    fn with_position(shared: Arc<StreamingBuffer>, position: u64) -> Self {
        Self { shared, position }
    }
}

impl Read for StreamingBufferReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            {
                let state = self.shared.state.lock().unwrap();

                let available = state.bytes.len() as u64;

                if self.position < available {
                    let start = self.position as usize;
                    let end = (start + buf.len()).min(state.bytes.len());

                    let slice = &state.bytes[start..end];

                    let len = slice.len();

                    buf[..len].copy_from_slice(slice);

                    self.position += len as u64;

                    return Ok(len);
                }

                if let Some(error) = state.error.clone() {
                    return Err(io::Error::new(io::ErrorKind::Other, error));
                }

                if state.done {
                    return Ok(0);
                }
            }

            let state = self.shared.state.lock().unwrap();

            let guard = self.shared.ready.wait(state).unwrap();

            drop(guard);
        }
    }
}

impl Seek for StreamingBufferReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let state = self.shared.state.lock().unwrap();
        let available = state.bytes.len() as i128;
        let target = match pos {
            SeekFrom::Start(offset) => offset as i128,
            SeekFrom::Current(offset) => self.position as i128 + offset as i128,
            SeekFrom::End(offset) => available + offset as i128,
        };

        if target < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot seek before start of stream",
            ));
        }

        if target <= available {
            self.position = target as u64;
            return Ok(self.position);
        }

        if let Some(error) = state.error.clone() {
            return Err(io::Error::new(io::ErrorKind::Other, error));
        }

        if state.done {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "cannot seek beyond downloaded audio",
            ));
        }

        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "stream seek target is not buffered yet",
        ))
    }
}

fn decoder_hint_from_stream(
    url: &str,
    content_type: Option<&str>,
) -> (Option<&'static str>, Option<String>) {
    let normalized_mime = content_type
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty());

    let hint = if let Some(mime) = normalized_mime.as_deref() {
        if mime.contains("mpeg") || mime.contains("mp3") {
            Some("mp3")
        } else if mime.contains("audio/mp4") || mime.contains("aac") || mime.contains("mp4a") {
            Some("mp4")
        } else if mime.contains("ogg") || mime.contains("opus") {
            Some("ogg")
        } else {
            None
        }
    } else if url.contains("hls_aac") {
        Some("mp4")
    } else if url.contains("ogg") || url.contains("opus") {
        Some("ogg")
    } else if url.contains("mp3") {
        Some("mp3")
    } else {
        None
    };

    (hint, normalized_mime)
}

fn create_player_from_stream_reader(
    reader: StreamingBufferReader,
    url: &str,
    content_type: Option<&str>,
    mixer: &Mixer,
    volume: f32,
    playback_speed: f32,
    normalization_gain: f32,
    eq_params: Arc<RwLock<EqParams>>,
    pitch_params: Arc<RwLock<PitchParams>>,
    vis_tx: Option<std::sync::mpsc::SyncSender<Vec<f32>>>,
) -> Result<(Player, Option<f64>), String> {
    let (hint, normalized_mime) = decoder_hint_from_stream(url, content_type);
    let mut builder = Decoder::builder().with_data(reader);
    if let Some(hint) = hint {
        builder = builder.with_hint(hint);
    }
    if let Some(mime) = normalized_mime.as_deref() {
        builder = builder.with_mime_type(mime);
    }

    let source = builder
        .build()
        .map_err(|error| format!("Failed to decode streaming audio: {}", error))?;

    wrap_source_into_player(
        source,
        mixer,
        volume,
        playback_speed,
        normalization_gain,
        eq_params,
        pitch_params,
        vis_tx,
    )
}

/* ── Audio State (managed by Tauri) ────────────────────────── */

/// Messages sent to the media controls thread
enum MediaCmd {
    SetMetadata {
        title: String,
        artist: String,
        cover_url: Option<String>,
        duration_secs: f64,
    },
    SetPlaying(bool),
    SetPosition(f64),
}

/// Command sent to the audio output thread (which owns MixerDeviceSink)
enum AudioThreadCmd {
    SwitchDevice {
        name: Option<String>,
        reply: std::sync::mpsc::Sender<Result<Mixer, String>>,
    },
    /// Auto-reconnect when the audio device is invalidated (e.g. BT profile switch)
    Reconnect,
}

#[derive(Clone, Copy, Debug, Default)]
struct PositionAnchor {
    timeline_secs: f64,
    output_secs: f64,
}

pub struct AudioState {
    player: Mutex<Option<Arc<Player>>>,
    crossfade_player: Mutex<Option<Arc<Player>>>,
    mixer: Arc<Mutex<Mixer>>,
    eq_params: Arc<RwLock<EqParams>>,
    pitch_params: Arc<RwLock<PitchParams>>,
    normalization_enabled: AtomicBool,
    normalization_gain: Mutex<f32>,
    volume: Mutex<f32>, // 0.0 - 1.0
    playback_speed: Mutex<f32>,
    position_anchor: Mutex<PositionAnchor>,
    has_track: AtomicBool,
    ended_notified: AtomicBool,
    /// Set by error callback when stream breaks, cleared after reconnect completes
    device_error: Arc<AtomicBool>,
    /// Set by audio thread on device reconnect (e.g. BT profile switch), cleared by tick emitter
    device_reconnected: Arc<AtomicBool>,
    load_gen: Arc<AtomicU64>,
    media_tx: Mutex<Option<std::sync::mpsc::Sender<MediaCmd>>>,
    audio_tx: std::sync::mpsc::Sender<AudioThreadCmd>,
    /// Saved source bytes for seek fallback (reload + seek forward)
    source_bytes: Arc<Mutex<Option<Vec<u8>>>>,
    live_stream_buffer: Arc<Mutex<Option<Arc<StreamingBuffer>>>>,
    stream_source_url: Mutex<Option<String>>,
    stream_content_type: Mutex<Option<String>>,
    stream_total_bytes: Arc<AtomicU64>,
    stream_downloaded_bytes: Arc<AtomicU64>,
    stream_duration_ms: Arc<AtomicU64>,
    tick_event_token: Arc<AtomicU64>,
    seek_in_progress: AtomicBool,
    pub visualizer_tx: Mutex<Option<std::sync::mpsc::SyncSender<Vec<f32>>>>,
    pub frame_target: AtomicU32,
    pub frame_unlocked: AtomicBool,
    pub window_visible: AtomicBool,
}

fn clamp_target_fps(target: u32) -> u32 {
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

fn current_event_interval_ms(state: &AudioState) -> u64 {
    if !state.window_visible.load(Ordering::Relaxed) {
        return 250;
    }
    let unlocked = state.frame_unlocked.load(Ordering::Relaxed);
    let target = clamp_target_fps(state.frame_target.load(Ordering::Relaxed));
    let fps = if unlocked { UNLOCKED_EVENT_FPS } else { target };
    ((1000.0 / fps as f64).round() as u64).max(1)
}

pub fn set_framerate_config(state: &AudioState, target: u32, unlocked: bool) {
    state
        .frame_target
        .store(clamp_target_fps(target), Ordering::Relaxed);
    state.frame_unlocked.store(unlocked, Ordering::Relaxed);
}

fn open_device_sink(
    device_id: Option<&str>,
    reconnect_tx: &std::sync::mpsc::Sender<AudioThreadCmd>,
    error_flag: &Arc<AtomicBool>,
) -> Result<rodio::stream::MixerDeviceSink, String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    // Error callback: on stream error (e.g. BT profile switch → AUDCLNT_E_DEVICE_INVALIDATED),
    // signal audio thread to reconnect. AtomicBool prevents spamming.
    let sent = Arc::new(AtomicBool::new(false));
    let sent_clone = sent.clone();
    let tx = reconnect_tx.clone();
    let err_flag = error_flag.clone();
    let error_cb = move |err: cpal::StreamError| {
        eprintln!("[audio] stream error: {err}");
        err_flag.store(true, Ordering::Relaxed);
        if !sent_clone.swap(true, Ordering::Relaxed) {
            tx.send(AudioThreadCmd::Reconnect).ok();
        }
    };

    if let Some(id) = device_id {
        let host = cpal::default_host();
        if let Ok(devices) = host.output_devices() {
            for dev in devices {
                if dev.id().ok().map(|d| d.to_string()).as_deref() == Some(id) {
                    let mut sink = DeviceSinkBuilder::from_device(dev)
                        .map_err(|e| format!("Failed to open device '{}': {}", id, e))?
                        .with_error_callback(error_cb)
                        .open_stream()
                        .map_err(|e| format!("Failed to open device '{}': {}", id, e))?;
                    sink.log_on_drop(false);
                    return Ok(sink);
                }
            }
        }
        return Err(format!("Device '{}' not found", id));
    }

    let mut sink = DeviceSinkBuilder::from_default_device()
        .map_err(|e| format!("No audio output: {}", e))?
        .with_error_callback(error_cb)
        .open_stream()
        .map_err(|e| format!("No audio output: {}", e))?;
    sink.log_on_drop(false);
    Ok(sink)
}

pub fn init() -> AudioState {
    // Spawn audio output on a dedicated thread (MixerDeviceSink may be !Send on some platforms)
    let (mixer_tx, mixer_rx) = std::sync::mpsc::channel::<Arc<Mutex<Mixer>>>();
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<AudioThreadCmd>();
    let device_error_flag = Arc::new(AtomicBool::new(false));
    let reconnected_flag = Arc::new(AtomicBool::new(false));

    let cmd_tx_for_thread = cmd_tx.clone();
    let reconnected_for_thread = reconnected_flag.clone();
    let error_flag_for_thread = device_error_flag.clone();
    std::thread::Builder::new()
        .name("audio-output".into())
        .spawn(move || {
            let cmd_tx = cmd_tx_for_thread;
            let reconnected = reconnected_for_thread;
            let error_flag = error_flag_for_thread;
            let mut device_sink =
                open_device_sink(None, &cmd_tx, &error_flag).expect("no audio output device");
            let shared_mixer = Arc::new(Mutex::new(device_sink.mixer().clone()));
            mixer_tx.send(shared_mixer.clone()).ok();

            loop {
                match cmd_rx.recv() {
                    Ok(AudioThreadCmd::SwitchDevice { name, reply }) => {
                        // Drop old sink first
                        drop(device_sink);

                        match open_device_sink(name.as_deref(), &cmd_tx, &error_flag) {
                            Ok(new_sink) => {
                                let mixer = new_sink.mixer().clone();
                                *shared_mixer.lock().unwrap() = mixer.clone();
                                device_sink = new_sink;
                                reply.send(Ok(mixer)).ok();
                            }
                            Err(e) => {
                                // Fallback to default
                                device_sink = open_device_sink(None, &cmd_tx, &error_flag)
                                    .expect("no audio output device");
                                *shared_mixer.lock().unwrap() = device_sink.mixer().clone();
                                reply.send(Err(e)).ok();
                            }
                        }
                    }
                    Ok(AudioThreadCmd::Reconnect) => {
                        eprintln!("[audio] device invalidated, reconnecting...");
                        // Small delay to let the OS settle after BT profile switch
                        std::thread::sleep(Duration::from_millis(500));

                        drop(device_sink);
                        match open_device_sink(None, &cmd_tx, &error_flag) {
                            Ok(new_sink) => {
                                *shared_mixer.lock().unwrap() = new_sink.mixer().clone();
                                device_sink = new_sink;
                                reconnected.store(true, Ordering::Relaxed);
                                eprintln!("[audio] reconnected successfully");
                            }
                            Err(e) => {
                                eprintln!("[audio] reconnect failed: {e}, retrying...");
                                std::thread::sleep(Duration::from_secs(1));
                                device_sink = open_device_sink(None, &cmd_tx, &error_flag)
                                    .expect("no audio output device");
                                *shared_mixer.lock().unwrap() = device_sink.mixer().clone();
                                reconnected.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .expect("failed to spawn audio thread");

    let shared_mixer = mixer_rx.recv().expect("audio thread failed to init");

    AudioState {
        player: Mutex::new(None),
        crossfade_player: Mutex::new(None),
        mixer: shared_mixer,
        eq_params: Arc::new(RwLock::new(EqParams::default())),
        pitch_params: Arc::new(RwLock::new(PitchParams::default())),
        normalization_enabled: AtomicBool::new(true),
        normalization_gain: Mutex::new(1.0),
        volume: Mutex::new(0.5), // 50/100
        playback_speed: Mutex::new(1.0),
        position_anchor: Mutex::new(PositionAnchor::default()),
        has_track: AtomicBool::new(false),
        ended_notified: AtomicBool::new(false),
        device_error: device_error_flag,
        device_reconnected: reconnected_flag,
        load_gen: Arc::new(AtomicU64::new(0)),
        media_tx: Mutex::new(None),
        audio_tx: cmd_tx,
        source_bytes: Arc::new(Mutex::new(None)),
        live_stream_buffer: Arc::new(Mutex::new(None)),
        stream_source_url: Mutex::new(None),
        stream_content_type: Mutex::new(None),
        stream_total_bytes: Arc::new(AtomicU64::new(0)),
        stream_downloaded_bytes: Arc::new(AtomicU64::new(0)),
        stream_duration_ms: Arc::new(AtomicU64::new(0)),
        tick_event_token: Arc::new(AtomicU64::new(0)),
        seek_in_progress: AtomicBool::new(false),
        visualizer_tx: Mutex::new(None),
        frame_target: AtomicU32::new(DEFAULT_TARGET_FPS),
        frame_unlocked: AtomicBool::new(false),
        window_visible: AtomicBool::new(true),
    }
}

/// Start background thread that emits position ticks and track-end events
pub fn start_tick_emitter(app: &AppHandle) {
    let handle = app.clone();
    std::thread::Builder::new()
        .name("audio-tick".into())
        .spawn(move || loop {
            let state = handle.state::<AudioState>();
            std::thread::sleep(Duration::from_millis(current_event_interval_ms(&state)));

            // Check if audio device was reconnected (e.g. BT profile switch)
            if state.device_reconnected.swap(false, Ordering::Relaxed) {
                handle.emit("audio:device-reconnected", ()).ok();
            }

            if !state.has_track.load(Ordering::Relaxed) {
                continue;
            }

            let player = state.player.lock().unwrap();
            if let Some(ref p) = *player {
                if p.empty() {
                    if state.seek_in_progress.load(Ordering::Relaxed) {
                        continue;
                    }
                    // Suppress track-end during device error (BT profile switch etc.)
                    if !state.device_error.load(Ordering::Relaxed)
                        && !state.ended_notified.swap(true, Ordering::Relaxed)
                    {
                        handle.emit("audio:ended", ()).ok();
                    }
                } else {
                    let playback_speed = *state.playback_speed.lock().unwrap();
                    let anchor = *state.position_anchor.lock().unwrap();
                    let pos = timeline_position_from_output(p.get_pos(), anchor, playback_speed)
                        .as_secs_f64();
                    let tick_token = state.tick_event_token.load(Ordering::Relaxed);
                    handle
                        .emit(
                            "audio:tick",
                            serde_json::json!({
                                "gen": tick_token,
                                "position": pos,
                            }),
                        )
                        .ok();
                }
            }
        })
        .expect("failed to spawn tick thread");
}

/// Start media controls (MPRIS on Linux, SMTC on Windows) on a dedicated thread
pub fn start_media_controls(app: &AppHandle) {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<MediaCmd>();

    // Store sender in AudioState
    let state = app.state::<AudioState>();
    *state.media_tx.lock().unwrap() = Some(tx);

    std::thread::Builder::new()
        .name("media-controls".into())
        .spawn(move || {
            #[cfg(not(target_os = "windows"))]
            let hwnd = None;

            #[cfg(target_os = "windows")]
            let hwnd = {
                use tauri::Manager;
                handle.get_webview_window("main").and_then(|w| {
                    use raw_window_handle::HasWindowHandle;
                    w.window_handle().ok().and_then(|wh| match wh.as_raw() {
                        raw_window_handle::RawWindowHandle::Win32(h) => {
                            Some(h.hwnd.get() as *mut std::ffi::c_void)
                        }
                        _ => None,
                    })
                })
            };

            let config = PlatformConfig {
                display_name: "SoundCloud Desktop",
                dbus_name: "soundcloud_desktop",
                hwnd,
            };

            let mut controls = match MediaControls::new(config) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[MediaControls] Failed to create: {:?}", e);
                    return;
                }
            };

            let event_handle = handle.clone();
            controls
                .attach(move |event: MediaControlEvent| match event {
                    MediaControlEvent::Play => {
                        event_handle.emit("media:play", ()).ok();
                    }
                    MediaControlEvent::Pause => {
                        event_handle.emit("media:pause", ()).ok();
                    }
                    MediaControlEvent::Toggle => {
                        event_handle.emit("media:toggle", ()).ok();
                    }
                    MediaControlEvent::Next => {
                        event_handle.emit("media:next", ()).ok();
                    }
                    MediaControlEvent::Previous => {
                        event_handle.emit("media:prev", ()).ok();
                    }
                    MediaControlEvent::SetPosition(MediaPosition(pos)) => {
                        event_handle.emit("media:seek", pos.as_secs_f64()).ok();
                    }
                    MediaControlEvent::Seek(dir) => {
                        let offset = match dir {
                            souvlaki::SeekDirection::Forward => 10.0,
                            souvlaki::SeekDirection::Backward => -10.0,
                        };
                        event_handle.emit("media:seek-relative", offset).ok();
                    }
                    _ => {}
                })
                .ok();

            // Process commands from main thread
            loop {
                match rx.recv() {
                    Ok(MediaCmd::SetMetadata {
                        title,
                        artist,
                        cover_url,
                        duration_secs,
                    }) => {
                        controls
                            .set_metadata(SmtcMetadata {
                                title: Some(&title),
                                artist: Some(&artist),
                                cover_url: cover_url.as_deref(),
                                duration: if duration_secs > 0.0 {
                                    Some(Duration::from_secs_f64(duration_secs))
                                } else {
                                    None
                                },
                                ..Default::default()
                            })
                            .ok();
                    }
                    Ok(MediaCmd::SetPlaying(playing)) => {
                        let state = handle.state::<AudioState>();
                        let playback_speed = *state.playback_speed.lock().unwrap();
                        let anchor = *state.position_anchor.lock().unwrap();
                        let pos = state
                            .player
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|p| {
                                timeline_position_from_output(p.get_pos(), anchor, playback_speed)
                            })
                            .unwrap_or_default();
                        let progress = Some(MediaPosition(pos));
                        let playback = if playing {
                            MediaPlayback::Playing { progress }
                        } else {
                            MediaPlayback::Paused { progress }
                        };
                        controls.set_playback(playback).ok();
                    }
                    Ok(MediaCmd::SetPosition(secs)) => {
                        // Just update position without changing play state
                        let state = handle.state::<AudioState>();
                        let is_playing = state
                            .player
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|p| !p.is_paused() && !p.empty())
                            .unwrap_or(false);
                        let progress = Some(MediaPosition(Duration::from_secs_f64(secs)));
                        let playback = if is_playing {
                            MediaPlayback::Playing { progress }
                        } else {
                            MediaPlayback::Paused { progress }
                        };
                        controls.set_playback(playback).ok();
                    }
                    Err(_) => break, // Channel closed
                }
            }
        })
        .expect("failed to spawn media-controls thread");
}

/* ── Tauri Commands ────────────────────────────────────────── */

fn volume_to_rodio(v: f64) -> f32 {
    // Frontend: 0-100, where 100 = normal. rodio: 0.0 = silent, 1.0 = normal
    (v / 100.0).min(1.0).max(0.0) as f32
}

fn effective_output_volume(_state: &AudioState, base_volume: f32) -> f32 {
    base_volume.clamp(0.0, 1.0)
}

fn clamp_playback_rate(value: f64) -> f32 {
    (value as f32).clamp(PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX)
}

fn clamp_pitch_semitones(value: f64) -> f32 {
    (value as f32).clamp(PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX)
}

fn is_neutral_pitch_semitones(semitones: f32) -> bool {
    semitones.abs() < 0.001
}

fn is_default_playback_rate(playback_speed: f32) -> bool {
    (playback_speed - 1.0).abs() < 0.001
}

fn is_identity_processing(playback_speed: f32, semitones: f32) -> bool {
    is_default_playback_rate(playback_speed) && is_neutral_pitch_semitones(semitones)
}

fn effective_playback_rate(playback_speed: f32) -> f64 {
    playback_speed.clamp(PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX) as f64
}

fn timeline_position_from_output(
    output_position: Duration,
    anchor: PositionAnchor,
    playback_speed: f32,
) -> Duration {
    let output_secs = output_position.as_secs_f64();
    let delta_output_secs = (output_secs - anchor.output_secs).max(0.0);
    Duration::from_secs_f64(
        (anchor.timeline_secs + delta_output_secs * effective_playback_rate(playback_speed))
            .max(0.0),
    )
}

fn timeline_position_secs_for_output(
    output_position: Duration,
    anchor: PositionAnchor,
    playback_speed: f32,
) -> f64 {
    timeline_position_from_output(output_position, anchor, playback_speed).as_secs_f64()
}

fn set_position_anchor(state: &AudioState, timeline_secs: f64, output_secs: f64) {
    *state.position_anchor.lock().unwrap() = PositionAnchor {
        timeline_secs: timeline_secs.max(0.0),
        output_secs: output_secs.max(0.0),
    };
}

fn rebase_position_anchor(state: &AudioState, output_position: Duration, playback_speed: f32) {
    let output_secs = output_position.as_secs_f64();
    let current_timeline_secs = {
        let anchor = *state.position_anchor.lock().unwrap();
        timeline_position_secs_for_output(output_position, anchor, playback_speed)
    };
    set_position_anchor(state, current_timeline_secs, output_secs);
}

fn pitch_ratio_from_semitones(semitones: f32) -> f64 {
    2f64.powf((semitones as f64) / 12.0)
}

fn store_seek_fallback_bytes(state: &AudioState, bytes: Vec<u8>) {
    if bytes.len() <= MAX_SEEK_FALLBACK_SOURCE_BYTES {
        *state.source_bytes.lock().unwrap() = Some(bytes);
    } else {
        *state.source_bytes.lock().unwrap() = None;
    }
}

fn clear_stream_seek_tracking(state: &AudioState) {
    if let Ok(mut live_stream_buffer) = state.live_stream_buffer.try_lock() {
        *live_stream_buffer = None;
    }
    if let Ok(mut stream_source_url) = state.stream_source_url.try_lock() {
        *stream_source_url = None;
    }
    if let Ok(mut stream_content_type) = state.stream_content_type.try_lock() {
        *stream_content_type = None;
    }
    state.stream_total_bytes.store(0, Ordering::Relaxed);
    state.stream_downloaded_bytes.store(0, Ordering::Relaxed);
    state.stream_duration_ms.store(0, Ordering::Relaxed);
}

fn set_stream_seek_tracking(state: &AudioState, duration_secs: Option<f64>) {
    let duration_ms = duration_secs
        .map(|secs| (secs.max(0.0) * 1000.0).round() as u64)
        .unwrap_or(0);
    state
        .stream_duration_ms
        .store(duration_ms, Ordering::Relaxed);
}

fn estimated_stream_buffered_timeline_secs(state: &AudioState) -> Option<f64> {
    let total = state.stream_total_bytes.load(Ordering::Relaxed);
    let downloaded = state.stream_downloaded_bytes.load(Ordering::Relaxed);
    let duration_ms = state.stream_duration_ms.load(Ordering::Relaxed);

    if total == 0 || downloaded == 0 || duration_ms == 0 {
        return None;
    }

    let ratio = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
    Some((duration_ms as f64 / 1000.0) * ratio)
}

fn emit_stream_download_progress(
    app: &AppHandle,
    event_token: u64,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    done: bool,
    ranged_seek_load: bool,
    cache_complete: bool,
) {
    let progress = if ranged_seek_load {
        None
    } else {
        total_bytes
            .filter(|size| *size > 0)
            .map(|size| (downloaded_bytes as f64 / size as f64).clamp(0.0, 1.0))
    };

    let _ = app.emit(
        "audio:download_progress",
        serde_json::json!({
            "gen": event_token,
            "progress": progress,
            "downloadedBytes": downloaded_bytes,
            "totalBytes": total_bytes,
            "done": done,
            "rangedSeekLoad": ranged_seek_load,
            "cacheComplete": cache_complete,
        }),
    );
}

#[derive(Clone, Copy, Debug)]
struct RangeSeekPlan {
    start_byte: u64,
    base_secs: f64,
    local_seek_secs: f64,
}

fn parse_total_size_from_content_range(value: Option<&str>) -> Option<u64> {
    let raw = value?.trim();
    let (_, total_part) = raw.split_once('/')?;
    if total_part == "*" {
        return None;
    }
    total_part.parse::<u64>().ok()
}

fn content_type_is_hls_playlist(value: Option<&str>) -> bool {
    value
        .map(|raw| raw.to_ascii_lowercase())
        .map(|raw| raw.contains("mpegurl") || raw.contains("vnd.apple"))
        .unwrap_or(false)
}

async fn stream_response_into_live_targets(
    response: reqwest::Response,
    shared_buffer: &Arc<StreamingBuffer>,
    cache_writer: &mut Option<BufWriter<TokioFile>>,
    cache_temp_path: Option<&str>,
    stream_downloaded_bytes: &Arc<AtomicU64>,
    app: &tauri::AppHandle,
    gen: u64,
    total_downloaded: &mut u64,
    total_size: Option<u64>,
    is_ranged_seek_load: bool,
    cancel_download: &Arc<AtomicBool>,
    load_gen: &Arc<AtomicU64>,
    active_gen: u64,
) -> Result<(), String> {
    let mut body_stream = response.bytes_stream();

    while let Some(chunk_result) = body_stream.next().await {
        if cancel_download.load(Ordering::Relaxed) || load_gen.load(Ordering::Relaxed) != active_gen
        {
            return Err("stream download cancelled".to_string());
        }

        let chunk = chunk_result.map_err(|error| error.to_string())?;
        *total_downloaded = total_downloaded.saturating_add(chunk.len() as u64);
        stream_downloaded_bytes.store(*total_downloaded, Ordering::Relaxed);
        shared_buffer.append(chunk.as_ref());

        if let Some(writer) = cache_writer.as_mut() {
            if let Err(error) = writer.write_all(&chunk).await {
                eprintln!("[Audio] Streaming cache write failed: {error}");
                *cache_writer = None;
                if let Some(temp_path) = cache_temp_path {
                    tokio::fs::remove_file(temp_path).await.ok();
                }
            }
        }

        emit_stream_download_progress(
            app,
            gen,
            *total_downloaded,
            total_size,
            false,
            is_ranged_seek_load,
            false,
        );
    }

    Ok(())
}

fn compute_range_seek_plan(
    target_secs: f64,
    duration_secs: f64,
    total_bytes: u64,
) -> Option<RangeSeekPlan> {
    if !target_secs.is_finite()
        || !duration_secs.is_finite()
        || target_secs <= 0.0
        || duration_secs <= 0.0
        || total_bytes == 0
    {
        return None;
    }

    let preroll_secs = target_secs.min(RANGE_SEEK_PREROLL_SECS);
    let requested_base_secs = (target_secs - preroll_secs).max(0.0);
    let raw_start_byte =
        ((requested_base_secs / duration_secs).clamp(0.0, 1.0) * total_bytes as f64).floor() as u64;
    let aligned_start_byte = raw_start_byte
        .saturating_sub(raw_start_byte % RANGE_SEEK_ALIGNMENT_BYTES)
        .min(total_bytes.saturating_sub(1));
    let effective_base_secs =
        (aligned_start_byte as f64 / total_bytes as f64).clamp(0.0, 1.0) * duration_secs;

    Some(RangeSeekPlan {
        start_byte: aligned_start_byte,
        base_secs: effective_base_secs,
        local_seek_secs: (target_secs - effective_base_secs).max(0.0),
    })
}

fn replace_player_after_seek(
    state: &AudioState,
    new_player: Player,
    anchor: PositionAnchor,
) -> Result<(), String> {
    let was_paused = state
        .player
        .try_lock()
        .map_err(|_| "Seek busy: player".to_string())?
        .as_ref()
        .map(|p| p.is_paused())
        .unwrap_or(false);

    let old_player = state
        .player
        .try_lock()
        .map_err(|_| "Seek busy: player".to_string())?
        .take();
    let old_cf_player = state
        .crossfade_player
        .try_lock()
        .map_err(|_| "Seek busy: crossfade player".to_string())?
        .take();

    if let Some(old) = old_player {
        old.stop();
    }
    if let Some(old_cf) = old_cf_player {
        old_cf.stop();
    }

    *state
        .player
        .try_lock()
        .map_err(|_| "Seek busy: player".to_string())? = Some(Arc::new(new_player));
    set_position_anchor(state, anchor.timeline_secs, anchor.output_secs);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.has_track.store(true, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    if was_paused {
        if let Some(ref p) = *state
            .player
            .try_lock()
            .map_err(|_| "Seek busy: player".to_string())?
        {
            p.pause();
        }
    }

    Ok(())
}

/// Load and play audio from a file path
#[tauri::command]
pub fn audio_load_file(
    event_token: Option<u64>,
    path: String,
    cache_key: Option<String>,
    crossfade_secs: Option<f64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let resolved_event_token =
        event_token.unwrap_or_else(|| state.load_gen.load(Ordering::Relaxed));
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    let playback_speed = *state.playback_speed.lock().unwrap();
    let normalization_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("audio-normalization"));
    let normalization_gain = if state.normalization_enabled.load(Ordering::Relaxed) {
        resolve_normalization_gain(
            &bytes,
            normalization_cache_dir.as_deref(),
            cache_key.as_deref(),
        )?
    } else {
        1.0
    };
    if let Ok(mut live_stream_buffer) = state.live_stream_buffer.try_lock() {
        *live_stream_buffer = None;
    }
    let (new_player, duration_secs) = create_player_from_owned_bytes(
        bytes.clone(),
        &mixer,
        vol,
        playback_speed,
        normalization_gain,
        state.eq_params.clone(),
        state.pitch_params.clone(),
        state.visualizer_tx.lock().unwrap().clone(),
    )?;
    let new_player = Arc::new(new_player);
    *state.normalization_gain.lock().unwrap() = normalization_gain;

    let mut old_player_opt = None;
    {
        let mut player = state.player.lock().unwrap();
        if let Some(old) = player.take() {
            old_player_opt = Some(old);
        }
    }

    let effective_vol = effective_output_volume(&state, vol);
    if let Some(cf_duration) = crossfade_secs {
        if let Some(old_player) = old_player_opt {
            if !old_player.is_paused() && !old_player.empty() {
                // We have a fading-out track. Move it to crossfade_player
                let mut cf_lock = state.crossfade_player.lock().unwrap();
                if let Some(old_cf) = cf_lock.take() {
                    old_cf.stop();
                }

                new_player.set_volume(0.0);
                *cf_lock = Some(old_player.clone());

                let cf_player = old_player.clone();
                let np_player = new_player.clone();
                let steps = (cf_duration * 1000.0 / 20.0) as u32;
                if steps > 0 {
                    std::thread::spawn(move || {
                        let target = (effective_vol * CROSSFADE_HEADROOM).clamp(0.0, 1.0);
                        for i in 0..=steps {
                            let t = (i as f32) / (steps as f32);
                            let np_v = (t * t * target).clamp(0.0, 1.0);
                            let cf_v = ((1.0 - t * t) * target).clamp(0.0, 1.0);
                            np_player.set_volume(np_v);
                            cf_player.set_volume(cf_v);
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        cf_player.stop();
                    });
                } else {
                    new_player.set_volume(effective_vol.clamp(0.0, 1.0));
                    old_player.stop();
                }
            } else {
                old_player.stop();
            }
        }
    } else {
        if let Some(old) = old_player_opt {
            old.stop();
        }
    }

    *state.player.lock().unwrap() = Some(new_player);
    state
        .tick_event_token
        .store(resolved_event_token, Ordering::Relaxed);
    set_position_anchor(&state, 0.0, 0.0);
    clear_stream_seek_tracking(&state);
    set_stream_seek_tracking(&state, duration_secs);
    store_seek_fallback_bytes(&state, bytes);
    state.has_track.store(true, Ordering::Relaxed);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    Ok(AudioLoadResult {
        duration_secs,
        stream_quality: None,
        stream_content_type: None,
    })
}

#[derive(serde::Serialize)]
pub struct AudioLoadResult {
    pub duration_secs: Option<f64>,
    pub stream_quality: Option<String>,
    pub stream_content_type: Option<String>,
}

/// Load and play audio from a URL (starts playback while bytes continue streaming).
#[tauri::command]
pub async fn audio_load_url(
    progress_token: Option<u64>,
    url: String,
    session_id: Option<String>,
    stream_content_type_hint: Option<String>,
    cache_path: Option<String>,
    cache_key: Option<String>,
    crossfade_secs: Option<f64>,
    expected_duration_secs: Option<f64>,
    range_seek_target_secs: Option<f64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
) -> Result<AudioLoadResult, String> {
    let gen = state.load_gen.load(Ordering::Relaxed);
    let event_token = progress_token.unwrap_or(gen);
    let range_seek_target_secs =
        range_seek_target_secs.filter(|secs| secs.is_finite() && *secs > 0.0);
    let range_seek_duration_secs = range_seek_target_secs
        .and_then(|_| expected_duration_secs);
    let is_ranged_seek_load = range_seek_target_secs.is_some();

    let normalization_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("audio-normalization"));
    let normalization_enabled = state.normalization_enabled.load(Ordering::Relaxed);
    let normalization_gain = if normalization_enabled {
        read_cached_normalization_gain(normalization_cache_dir.as_deref(), cache_key.as_deref())
            .unwrap_or(1.0)
    } else {
        1.0
    };

    let shared_buffer = Arc::new(StreamingBuffer::default());
    let reader = StreamingBufferReader::new(shared_buffer.clone());
    let cancel_download = Arc::new(AtomicBool::new(false));
    clear_stream_seek_tracking(&state);
    if let Ok(mut live_stream_buffer) = state.live_stream_buffer.try_lock() {
        *live_stream_buffer = Some(shared_buffer.clone());
    }
    if let Ok(mut stream_source_url) = state.stream_source_url.try_lock() {
        *stream_source_url = Some(url.clone());
    }

    let load_gen = state.load_gen.clone();
    let source_bytes = state.source_bytes.clone();
    let stream_total_bytes = state.stream_total_bytes.clone();
    let stream_downloaded_bytes = state.stream_downloaded_bytes.clone();
    let cache_path_for_download = cache_path.clone();
    let cache_key_for_download = cache_key.clone();
    let normalization_cache_dir_for_download = normalization_cache_dir.clone();
    let shared_buffer_for_download = shared_buffer.clone();
    let cancel_for_download = cancel_download.clone();
    let app_for_download = app.clone();
    let url_for_download = url.clone();
    let session_id_for_download = session_id.clone();
    let stream_content_type_hint_for_download = stream_content_type_hint.clone();
    let range_seek_target_for_download = range_seek_target_secs;
    let range_seek_duration_for_download = range_seek_duration_secs;
    let is_ranged_seek_load_for_download = is_ranged_seek_load;
    let (bootstrap_tx, bootstrap_rx) = std::sync::mpsc::sync_channel::<
        Result<
            (
                Option<String>,
                Option<String>,
                Option<u64>,
                Option<f64>,
                Option<f64>,
                u64,
            ),
            String,
        >,
    >(1);

    std::thread::Builder::new()
        .name("audio-stream-download".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = bootstrap_tx.send(Err(format!(
                        "Failed to start stream runtime: {}",
                        error
                    )));
                    return;
                }
            };

            runtime.block_on(async move {
                let mut resolved_total_size = None;
                let mut planned_range_seek = None;
                let cache_temp_path_for_download = cache_path_for_download
                    .as_ref()
                    .filter(|_| !is_ranged_seek_load_for_download)
                    .map(|path| format!("{path}.part"));
                let mut resume_cached_bytes = Vec::new();
                let mut resume_cached_len = 0u64;

                if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                    if let Ok(meta) = tokio::fs::metadata(temp_path).await {
                        if meta.len() > 0 {
                            match tokio::fs::read(temp_path).await {
                                Ok(bytes) if !bytes.is_empty() => {
                                    resume_cached_len = bytes.len() as u64;
                                    resume_cached_bytes = bytes;
                                }
                                Ok(_) => {}
                                Err(error) => {
                                    eprintln!(
                                        "[Audio] Failed to read partial streaming cache {temp_path}: {error}"
                                    );
                                }
                            }
                        }
                    }
                }

                if let (Some(target_secs), Some(duration_secs)) = (
                    range_seek_target_for_download,
                    range_seek_duration_for_download,
                ) {
                    if resolved_total_size.is_none() {
                        let mut probe_headers = vec![("range".to_string(), "bytes=0-0".to_string())];
                        if let Some(sid) = session_id_for_download.as_deref() {
                            probe_headers.push(("x-session-id".to_string(), sid.to_string()));
                        }

                        if let Ok((probe_resp, _, _)) = crate::media_proxy::perform_get(
                            &url_for_download,
                            &probe_headers,
                            None,
                            crate::media_proxy::ClientProfile::Download,
                        )
                        .await
                        {
                            resolved_total_size = parse_total_size_from_content_range(
                                probe_resp
                                    .headers()
                                    .get("content-range")
                                    .and_then(|value| value.to_str().ok()),
                            )
                            .or_else(|| {
                                probe_resp
                                    .headers()
                                    .get("content-length")
                                    .and_then(|value| value.to_str().ok())
                                    .and_then(|value| value.parse::<u64>().ok())
                            });
                        }
                    }

                    if let Some(total_size) = resolved_total_size {
                        planned_range_seek =
                            compute_range_seek_plan(target_secs, duration_secs, total_size);
                    }
                }

                let mut requested_range_start = planned_range_seek
                    .map(|plan| plan.start_byte)
                    .unwrap_or(0);
                if requested_range_start == 0 && resume_cached_len > 0 {
                    requested_range_start = resume_cached_len;
                }

                let mut request_headers = Vec::new();
                if let Some(sid) = session_id_for_download.as_deref() {
                    request_headers.push(("x-session-id".to_string(), sid.to_string()));
                }
                if requested_range_start > 0 {
                    request_headers.push((
                        "range".to_string(),
                        format!("bytes={requested_range_start}-"),
                    ));
                }

                let (resp, routing_decision, _) = match crate::media_proxy::perform_get(
                    &url_for_download,
                    &request_headers,
                    None,
                    crate::media_proxy::ClientProfile::Download,
                )
                .await
                {
                    Ok(result) => result,
                    Err(error) => {
                        let _ = bootstrap_tx.send(Err(error));
                        return;
                    }
                };
                let client = match routing_decision.build_client(crate::media_proxy::ClientProfile::Download) {
                    Ok(client) => client,
                    Err(error) => {
                        let _ = bootstrap_tx.send(Err(error));
                        return;
                    }
                };

                if !resp.status().is_success() {
                    let _ = bootstrap_tx.send(Err(format!("HTTP {}", resp.status())));
                    return;
                }

                let stream_quality = resp
                    .headers()
                    .get("x-stream-quality")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_ascii_lowercase())
                    .filter(|v| v == "hq" || v == "lq");
                let response_content_type = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_ascii_lowercase());
                let is_hls_stream = response_is_hls(&resp, &url_for_download)
                    || content_type_is_hls_playlist(response_content_type.as_deref());
                let stream_content_type = if is_hls_stream {
                    stream_content_type_hint_for_download.clone().or_else(|| {
                        response_content_type
                            .clone()
                            .filter(|value| !content_type_is_hls_playlist(Some(value.as_str())))
                    })
                } else {
                    response_content_type.clone()
                };

                let mut downloaded = 0u64;
                let mut cache_writer: Option<BufWriter<TokioFile>>;
                let total_size;
                let applied_range_seek;
                let absolute_downloaded_base;

                if is_hls_stream {
                    if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                        tokio::fs::remove_file(temp_path).await.ok();
                    }

                    total_size = None;
                    applied_range_seek = range_seek_target_for_download.map(|target_secs| RangeSeekPlan {
                        start_byte: 0,
                        base_secs: 0.0,
                        local_seek_secs: target_secs,
                    });
                    absolute_downloaded_base = 0;
                    stream_total_bytes.store(0, Ordering::Relaxed);
                    stream_downloaded_bytes.store(0, Ordering::Relaxed);

                    if bootstrap_tx
                        .send(Ok((
                            stream_quality.clone(),
                            stream_content_type.clone(),
                            total_size,
                            applied_range_seek.map(|plan| plan.base_secs),
                            applied_range_seek.map(|plan| plan.local_seek_secs),
                            absolute_downloaded_base,
                        )))
                        .is_err()
                    {
                        return;
                    }

                    cache_writer = if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                        match TokioFile::create(temp_path).await {
                            Ok(file) => Some(BufWriter::with_capacity(
                                STREAM_CACHE_WRITE_BUFFER_SIZE,
                                file,
                            )),
                            Err(error) => {
                                eprintln!(
                                    "[Audio] Failed to create HLS cache temp file {temp_path}: {error}"
                                );
                                None
                            }
                        }
                    } else {
                        None
                    };

                    let playlist = match resolve_media_playlist(&client, resp, &url_for_download).await {
                        Ok(playlist) => playlist,
                        Err(error) => {
                            if let Some(mut writer) = cache_writer.take() {
                                let _ = writer.flush().await;
                            }
                            shared_buffer_for_download.fail(error);
                            return;
                        }
                    };
                    println!("[Audio] Direct HLS playback via {}", playlist.playlist_url);

                    if let Some(init_url) = playlist.init_segment_url.as_deref() {
                        let init_response = match client.get(init_url).send().await {
                            Ok(response) => response,
                            Err(error) => {
                                if let Some(mut writer) = cache_writer.take() {
                                    let _ = writer.flush().await;
                                }
                                shared_buffer_for_download.fail(format!(
                                    "Failed to fetch HLS init segment: {error}"
                                ));
                                return;
                            }
                        };

                        if !init_response.status().is_success() {
                            if let Some(mut writer) = cache_writer.take() {
                                let _ = writer.flush().await;
                            }
                            shared_buffer_for_download.fail(format!(
                                "HLS init segment HTTP {}",
                                init_response.status()
                            ));
                            return;
                        }

                        if let Err(error) = stream_response_into_live_targets(
                            init_response,
                            &shared_buffer_for_download,
                            &mut cache_writer,
                            cache_temp_path_for_download.as_deref(),
                            &stream_downloaded_bytes,
                            &app_for_download,
                            event_token,
                            &mut downloaded,
                            total_size,
                            is_ranged_seek_load_for_download,
                            &cancel_for_download,
                            &load_gen,
                            gen,
                        )
                        .await
                        {
                            if let Some(mut writer) = cache_writer.take() {
                                let _ = writer.flush().await;
                            }
                            shared_buffer_for_download.fail(error);
                            return;
                        }
                    }

                    for segment_url in &playlist.segment_urls {
                        let segment_response = match client.get(segment_url).send().await {
                            Ok(response) => response,
                            Err(error) => {
                                if let Some(mut writer) = cache_writer.take() {
                                    let _ = writer.flush().await;
                                }
                                shared_buffer_for_download.fail(format!(
                                    "Failed to fetch HLS segment: {error}"
                                ));
                                return;
                            }
                        };

                        if !segment_response.status().is_success() {
                            if let Some(mut writer) = cache_writer.take() {
                                let _ = writer.flush().await;
                            }
                            shared_buffer_for_download.fail(format!(
                                "HLS segment HTTP {}",
                                segment_response.status()
                            ));
                            return;
                        }

                        if let Err(error) = stream_response_into_live_targets(
                            segment_response,
                            &shared_buffer_for_download,
                            &mut cache_writer,
                            cache_temp_path_for_download.as_deref(),
                            &stream_downloaded_bytes,
                            &app_for_download,
                            event_token,
                            &mut downloaded,
                            total_size,
                            is_ranged_seek_load_for_download,
                            &cancel_for_download,
                            &load_gen,
                            gen,
                        )
                        .await
                        {
                            if let Some(mut writer) = cache_writer.take() {
                                let _ = writer.flush().await;
                            }
                            shared_buffer_for_download.fail(error);
                            return;
                        }
                    }
                } else {
                    let content_length = resp
                        .headers()
                        .get("content-length")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok());
                    let partial_range_accepted = requested_range_start == 0
                        || resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
                    let resumed_from_partial_cache = planned_range_seek.is_none()
                        && resume_cached_len > 0
                        && requested_range_start == resume_cached_len
                        && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
                    if requested_range_start > 0 && !partial_range_accepted {
                        resume_cached_bytes.clear();
                        resume_cached_len = 0;
                        if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                            tokio::fs::remove_file(temp_path).await.ok();
                        }
                    }
                    applied_range_seek = if partial_range_accepted {
                        planned_range_seek
                    } else {
                        None
                    };
                    absolute_downloaded_base = if resumed_from_partial_cache {
                        resume_cached_len
                    } else {
                        applied_range_seek.map(|plan| plan.start_byte).unwrap_or(0)
                    };
                    total_size = parse_total_size_from_content_range(
                        resp.headers()
                            .get("content-range")
                            .and_then(|value| value.to_str().ok()),
                    )
                    .or(resolved_total_size)
                    .or_else(|| {
                        content_length.and_then(|length| {
                            if requested_range_start > 0
                                && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT
                            {
                                Some(requested_range_start.saturating_add(length))
                            } else {
                                Some(length)
                            }
                        })
                    });
                    stream_total_bytes.store(total_size.unwrap_or(0), Ordering::Relaxed);
                    stream_downloaded_bytes.store(absolute_downloaded_base, Ordering::Relaxed);
                    if resumed_from_partial_cache && !resume_cached_bytes.is_empty() {
                        shared_buffer_for_download.append(resume_cached_bytes.as_ref());
                    }

                    if bootstrap_tx
                        .send(Ok((
                            stream_quality.clone(),
                            stream_content_type.clone(),
                            total_size,
                            applied_range_seek.map(|plan| plan.base_secs),
                            applied_range_seek.map(|plan| plan.local_seek_secs),
                            absolute_downloaded_base,
                        )))
                        .is_err()
                    {
                        return;
                    }

                    cache_writer = if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                        let open_result = if resumed_from_partial_cache {
                            TokioOpenOptions::new().append(true).open(temp_path).await
                        } else {
                            tokio::fs::remove_file(temp_path).await.ok();
                            TokioFile::create(temp_path).await
                        };
                        match open_result {
                            Ok(file) => Some(BufWriter::with_capacity(
                                STREAM_CACHE_WRITE_BUFFER_SIZE,
                                file,
                            )),
                            Err(error) => {
                                eprintln!(
                                    "[Audio] Failed to create streaming cache temp file {temp_path}: {error}"
                                );
                                None
                            }
                        }
                    } else {
                        None
                    };

                    let mut body_stream = resp.bytes_stream();
                    while let Some(chunk_result) = body_stream.next().await {
                        if cancel_for_download.load(Ordering::Relaxed)
                            || load_gen.load(Ordering::Relaxed) != gen
                        {
                            if let Some(mut writer) = cache_writer.take() {
                                let _ = writer.flush().await;
                            }
                            shared_buffer_for_download.fail("stream download cancelled".into());
                            return;
                        }

                        match chunk_result {
                            Ok(chunk) => {
                                downloaded += chunk.len() as u64;
                                let absolute_downloaded =
                                    absolute_downloaded_base.saturating_add(downloaded);
                                stream_downloaded_bytes
                                    .store(absolute_downloaded, Ordering::Relaxed);
                                shared_buffer_for_download.append(chunk.as_ref());
                                if let Some(writer) = cache_writer.as_mut() {
                                    if let Err(error) = writer.write_all(&chunk).await {
                                        eprintln!("[Audio] Streaming cache write failed: {error}");
                                        cache_writer = None;
                                        if let Some(temp_path) =
                                            cache_temp_path_for_download.as_deref()
                                        {
                                            tokio::fs::remove_file(temp_path).await.ok();
                                        }
                                    }
                                }

                                emit_stream_download_progress(
                                    &app_for_download,
                                    event_token,
                                    absolute_downloaded,
                                    total_size,
                                    false,
                                    is_ranged_seek_load_for_download,
                                    false,
                                );
                            }
                            Err(error) => {
                                if let Some(mut writer) = cache_writer.take() {
                                    let _ = writer.flush().await;
                                }
                                shared_buffer_for_download.fail(error.to_string());
                                return;
                            }
                        }
                    }
                }

                let final_downloaded = absolute_downloaded_base.saturating_add(downloaded);
                let cache_complete = !is_ranged_seek_load_for_download
                    && (is_hls_stream
                        || total_size
                            .map(|size| final_downloaded >= size)
                            .unwrap_or(false));

                if let Some(mut writer) = cache_writer.take() {
                    if let Err(error) = writer.flush().await {
                        eprintln!("[Audio] Streaming cache flush failed: {error}");
                        if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                            tokio::fs::remove_file(temp_path).await.ok();
                        }
                    } else if let Some(temp_path) = cache_temp_path_for_download.as_deref() {
                        drop(writer);
                        if cache_complete {
                            if let Some(final_path) = cache_path_for_download.as_deref() {
                                match tokio::fs::rename(temp_path, final_path).await {
                                    Ok(()) => {
                                        write_stream_cache_metadata(
                                            final_path,
                                            stream_quality.as_deref(),
                                            final_downloaded,
                                            total_size,
                                        )
                                        .await;
                                    }
                                    Err(error) => {
                                        if complete_stream_cache_exists(final_path) {
                                            tokio::fs::remove_file(temp_path).await.ok();
                                        } else {
                                            tokio::fs::remove_file(final_path).await.ok();
                                            tokio::fs::remove_file(format!(
                                                "{final_path}{CACHE_METADATA_EXT}"
                                            ))
                                            .await
                                            .ok();
                                            match tokio::fs::rename(temp_path, final_path).await {
                                                Ok(()) => {
                                                    write_stream_cache_metadata(
                                                        final_path,
                                                        stream_quality.as_deref(),
                                                        final_downloaded,
                                                        total_size,
                                                    )
                                                    .await;
                                                }
                                                Err(second_error) => {
                                                    eprintln!(
                                                        "[Audio] Failed to finalize streaming cache {final_path}: {error}; {second_error}"
                                                    );
                                                    tokio::fs::remove_file(temp_path).await.ok();
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                shared_buffer_for_download.finish();
                stream_downloaded_bytes.store(final_downloaded, Ordering::Relaxed);
                emit_stream_download_progress(
                    &app_for_download,
                    event_token,
                    final_downloaded,
                    total_size,
                    true,
                    is_ranged_seek_load_for_download,
                    cache_complete,
                );

                if load_gen.load(Ordering::Relaxed) != gen {
                    return;
                }

                if is_ranged_seek_load_for_download {
                    *source_bytes.lock().unwrap() = None;
                } else {
                    let maybe_bytes = if shared_buffer_for_download.len() <= MAX_SEEK_FALLBACK_SOURCE_BYTES {
                        Some(shared_buffer_for_download.snapshot())
                    } else {
                        None
                    };
                    *source_bytes.lock().unwrap() = maybe_bytes.clone();

                    if normalization_enabled {
                        let Some(bytes_for_norm) = maybe_bytes else {
                            return;
                        };
                        let cache_dir = normalization_cache_dir_for_download.clone();
                        let cache_key = cache_key_for_download.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            let _ = resolve_normalization_gain(
                                &bytes_for_norm,
                                cache_dir.as_deref(),
                                cache_key.as_deref(),
                            );
                        })
                        .await;
                    }
                }
            });
        })
        .map_err(|error| format!("Failed to spawn stream worker: {}", error))?;

    let (
        stream_quality,
        stream_content_type,
        total_size,
        range_seek_base_secs,
        range_seek_local_target_secs,
        bootstrap_downloaded_bytes,
    ) = bootstrap_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|error| format!("Stream bootstrap timed out: {}", error))??;

    *state.source_bytes.lock().unwrap() = None;

    emit_stream_download_progress(
        &app,
        event_token,
        bootstrap_downloaded_bytes,
        total_size,
        false,
        is_ranged_seek_load,
        false,
    );

    // Stale check after download — another track may have started loading
    if state.load_gen.load(Ordering::Relaxed) != gen {
        cancel_download.store(true, Ordering::Relaxed);
        return Ok(AudioLoadResult {
            duration_secs: None,
            stream_quality: None,
            stream_content_type: None,
        });
    }

    let mixer = state.mixer.lock().unwrap().clone();
    let vol = *state.volume.lock().unwrap();
    let playback_speed = *state.playback_speed.lock().unwrap();
    if let Ok(mut cached_stream_content_type) = state.stream_content_type.try_lock() {
        *cached_stream_content_type = stream_content_type.clone();
    }
    let (new_player, duration_secs) = create_player_from_stream_reader(
        reader,
        &url,
        stream_content_type.as_deref(),
        &mixer,
        vol,
        playback_speed,
        normalization_gain,
        state.eq_params.clone(),
        state.pitch_params.clone(),
        state.visualizer_tx.lock().unwrap().clone(),
    )
    .map_err(|error| {
        cancel_download.store(true, Ordering::Relaxed);
        error
    })?;
    let new_player = Arc::new(new_player);
    *state.normalization_gain.lock().unwrap() = normalization_gain;
    set_stream_seek_tracking(&state, duration_secs.or(expected_duration_secs));
    let mut anchor_timeline_secs = 0.0;
    let mut anchor_output_secs = 0.0;

    if let Some(base_secs) = range_seek_base_secs {
        let requested_timeline_secs = range_seek_target_secs.unwrap_or(base_secs);
        let local_seek_secs = range_seek_local_target_secs.unwrap_or(0.0).max(0.0);

        if local_seek_secs > 0.015 {
            if new_player
                .try_seek(Duration::from_secs_f64(local_seek_secs))
                .is_ok()
            {
                anchor_timeline_secs = requested_timeline_secs.max(0.0);
                anchor_output_secs = new_player.get_pos().as_secs_f64();
            } else {
                anchor_timeline_secs = base_secs.max(0.0);
            }
        } else {
            anchor_timeline_secs = requested_timeline_secs.max(0.0);
        }
    }

    let mut old_player_opt = None;
    {
        let mut player = state.player.lock().unwrap();
        if let Some(old) = player.take() {
            old_player_opt = Some(old);
        }
    }

    let effective_vol = effective_output_volume(&state, vol);
    if let Some(cf_duration) = crossfade_secs {
        if let Some(old_player) = old_player_opt {
            if !old_player.is_paused() && !old_player.empty() {
                // We have a fading-out track. Move it to crossfade_player
                let mut cf_lock = state.crossfade_player.lock().unwrap();
                if let Some(old_cf) = cf_lock.take() {
                    old_cf.stop();
                }

                new_player.set_volume(0.0);
                *cf_lock = Some(old_player.clone());

                let cf_player = old_player.clone();
                let np_player = new_player.clone();
                let steps = (cf_duration * 1000.0 / 20.0) as u32;
                if steps > 0 {
                    std::thread::spawn(move || {
                        let target = (effective_vol * CROSSFADE_HEADROOM).clamp(0.0, 1.0);
                        for i in 0..=steps {
                            let t = (i as f32) / (steps as f32);
                            let np_v = (t * t * target).clamp(0.0, 1.0);
                            let cf_v = ((1.0 - t * t) * target).clamp(0.0, 1.0);
                            np_player.set_volume(np_v);
                            cf_player.set_volume(cf_v);
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        cf_player.stop();
                    });
                } else {
                    new_player.set_volume(effective_vol.clamp(0.0, 1.0));
                    old_player.stop();
                }
            } else {
                old_player.stop();
            }
        }
    } else {
        if let Some(old) = old_player_opt {
            old.stop();
        }
    }

    // Stale check again after processing stops
    if state.load_gen.load(Ordering::Relaxed) != gen {
        cancel_download.store(true, Ordering::Relaxed);
        return Ok(AudioLoadResult {
            duration_secs: None,
            stream_quality: None,
            stream_content_type: None,
        });
    }

    *state.player.lock().unwrap() = Some(new_player);
    state.tick_event_token.store(event_token, Ordering::Relaxed);
    set_position_anchor(&state, anchor_timeline_secs, anchor_output_secs);
    state.has_track.store(true, Ordering::Relaxed);
    state.ended_notified.store(false, Ordering::Relaxed);
    state.device_error.store(false, Ordering::Relaxed);

    Ok(AudioLoadResult {
        duration_secs,
        stream_quality,
        stream_content_type,
    })
}

#[tauri::command]
pub fn audio_play(state: tauri::State<'_, AudioState>) {
    if let Ok(player) = state.player.try_lock() {
        if let Some(ref p) = *player {
            p.play();
        }
    }
}

#[tauri::command]
pub fn audio_pause(state: tauri::State<'_, AudioState>) {
    if let Ok(player) = state.player.try_lock() {
        if let Some(ref p) = *player {
            p.pause();
        }
    }
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, AudioState>) {
    // Use try_lock to avoid blocking IPC if another thread holds the lock (e.g. stuck stop())
    state.has_track.store(false, Ordering::Relaxed);
    state.load_gen.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut player) = state.player.try_lock() {
        if let Some(old) = player.take() {
            old.stop();
        }
    }
    if let Ok(mut cf_player) = state.crossfade_player.try_lock() {
        if let Some(old_cf) = cf_player.take() {
            old_cf.stop();
        }
    }
    if let Ok(mut bytes) = state.source_bytes.try_lock() {
        *bytes = None;
    }
    clear_stream_seek_tracking(&state);
    set_position_anchor(&state, 0.0, 0.0);
}

#[tauri::command]
pub fn audio_begin_stream_reload(state: tauri::State<'_, AudioState>) {
    state.load_gen.fetch_add(1, Ordering::Relaxed);
    state.ended_notified.store(true, Ordering::Relaxed);
    if let Ok(mut bytes) = state.source_bytes.try_lock() {
        *bytes = None;
    }
    clear_stream_seek_tracking(&state);
}

#[tauri::command]
pub fn audio_seek(position: f64, state: tauri::State<'_, AudioState>) -> Result<(), String> {
    struct SeekInProgressGuard<'a> {
        state: &'a AudioState,
    }

    impl Drop for SeekInProgressGuard<'_> {
        fn drop(&mut self) {
            self.state.seek_in_progress.store(false, Ordering::Relaxed);
        }
    }

    state.seek_in_progress.store(true, Ordering::Relaxed);
    let _seek_guard = SeekInProgressGuard { state: &state };
    state.ended_notified.store(true, Ordering::Relaxed);

    let playback_speed = *state
        .playback_speed
        .try_lock()
        .map_err(|_| "Seek busy: playback rate".to_string())?;
    let anchor = *state
        .position_anchor
        .try_lock()
        .map_err(|_| "Seek busy: timeline anchor".to_string())?;
    let playback_rate = effective_playback_rate(playback_speed);
    let target_secs = position.max(0.0);
    let local_timeline_start_secs =
        (anchor.timeline_secs - anchor.output_secs * playback_rate).max(0.0);
    let local_target_secs =
        (anchor.output_secs + (target_secs - anchor.timeline_secs) / playback_rate).max(0.0);
    let current_player_target = Duration::from_secs_f64(local_target_secs);
    let has_fallback_source = state
        .source_bytes
        .try_lock()
        .map_err(|_| "Seek busy: source bytes".to_string())?
        .is_some();

    // Try normal seek first
    {
        let player = state
            .player
            .try_lock()
            .map_err(|_| "Seek busy: player".to_string())?;
        if let Some(ref p) = *player {
            let target_within_current_source = target_secs + 0.35 >= local_timeline_start_secs;
            if !has_fallback_source {
                if let Some(buffered_secs) = estimated_stream_buffered_timeline_secs(&state) {
                    if target_secs > buffered_secs + 1.8 {
                        return Err("Seek target is not buffered yet".into());
                    }
                } else {
                    let current_timeline_secs =
                        timeline_position_secs_for_output(p.get_pos(), anchor, playback_speed);
                    if target_secs > current_timeline_secs + 6.0 {
                        return Err("Seek target is not buffered yet".into());
                    }
                }
            }

            if target_within_current_source && p.try_seek(current_player_target).is_ok() {
                let landed_output = p.get_pos();
                let landed_output_secs = landed_output.as_secs_f64();
                if (landed_output_secs - local_target_secs).abs() <= 1.25 {
                    set_position_anchor(&state, target_secs, landed_output_secs);
                    state.ended_notified.store(false, Ordering::Relaxed);
                    state.has_track.store(true, Ordering::Relaxed);
                    state.device_error.store(false, Ordering::Relaxed);
                    return Ok(());
                }
            }
        }
    }

    let normalization_gain = if state.normalization_enabled.load(Ordering::Relaxed) {
        *state
            .normalization_gain
            .try_lock()
            .map_err(|_| "Seek busy: normalization".to_string())?
    } else {
        1.0
    };

    if !has_fallback_source {
        return Err("Seek target is not buffered yet".into());
    }

    // Final fallback: rebuild from cached/local bytes when we have a full enough source snapshot.
    let bytes = state
        .source_bytes
        .try_lock()
        .map_err(|_| "Seek busy: source bytes".to_string())?
        .clone();
    let Some(bytes) = bytes else {
        return Err("Seek target is not buffered yet".into());
    };

    let mixer = state
        .mixer
        .try_lock()
        .map_err(|_| "Seek busy: mixer".to_string())?
        .clone();
    let vol = *state
        .volume
        .try_lock()
        .map_err(|_| "Seek busy: volume".to_string())?;
    let (new_player, _) = create_player_from_owned_bytes(
        bytes,
        &mixer,
        vol,
        playback_speed,
        normalization_gain,
        state.eq_params.clone(),
        state.pitch_params.clone(),
        state
            .visualizer_tx
            .try_lock()
            .map_err(|_| "Seek busy: visualizer".to_string())?
            .clone(),
    )?;

    let anchor = if target_secs > 0.015 {
        let target = Duration::from_secs_f64(target_secs);
        if new_player.try_seek(target).is_ok() {
            PositionAnchor {
                timeline_secs: target_secs.max(0.0),
                output_secs: new_player.get_pos().as_secs_f64(),
            }
        } else {
            return Err("Failed to seek rebuilt local source".into());
        }
    } else {
        PositionAnchor {
            timeline_secs: 0.0,
            output_secs: 0.0,
        }
    };

    replace_player_after_seek(&state, new_player, anchor)
}

#[tauri::command]
pub fn audio_set_volume(volume: f64, state: tauri::State<'_, AudioState>) {
    let vol = volume_to_rodio(volume);
    *state.volume.lock().unwrap() = vol;
    if let Some(ref p) = *state.player.lock().unwrap() {
        p.set_volume(effective_output_volume(&state, vol));
    }
}

#[tauri::command]
pub fn audio_set_playback_rate(playback_rate: f64, state: tauri::State<'_, AudioState>) {
    let rate = clamp_playback_rate(playback_rate);
    let previous_rate = *state.playback_speed.lock().unwrap();

    if (rate - previous_rate).abs() >= 0.001 {
        if let Some(ref p) = *state.player.lock().unwrap() {
            rebase_position_anchor(&state, p.get_pos(), previous_rate);
        }
    }

    *state.playback_speed.lock().unwrap() = rate;

    #[cfg(target_os = "macos")]
    if let Some(ref p) = *state.player.lock().unwrap() {
        p.set_speed(rate);
    }

    if let Ok(mut params) = state.pitch_params.write() {
        params.playback_rate = rate;
    }
}

#[tauri::command]
pub fn audio_set_pitch(pitch_semitones: f64, state: tauri::State<'_, AudioState>) {
    let semitones = clamp_pitch_semitones(pitch_semitones);
    if let Ok(mut params) = state.pitch_params.write() {
        params.semitones = semitones;
    }
}

#[tauri::command]
pub fn audio_get_position(state: tauri::State<'_, AudioState>) -> f64 {
    let playback_speed = *state.playback_speed.lock().unwrap();
    let anchor = *state.position_anchor.lock().unwrap();
    state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| timeline_position_from_output(p.get_pos(), anchor, playback_speed).as_secs_f64())
        .unwrap_or(0.0)
}

#[tauri::command]
pub fn audio_set_eq(enabled: bool, gains: Vec<f64>, state: tauri::State<'_, AudioState>) {
    if let Ok(mut params) = state.eq_params.write() {
        params.enabled = enabled;
        for (i, &g) in gains.iter().enumerate().take(EQ_BANDS) {
            params.gains[i] = g.clamp(-12.0, 12.0);
        }
    }
}

#[tauri::command]
pub fn audio_set_normalization(enabled: bool, state: tauri::State<'_, AudioState>) {
    state
        .normalization_enabled
        .store(enabled, Ordering::Relaxed);
    let vol = *state.volume.lock().unwrap();
    if let Some(ref p) = *state.player.lock().unwrap() {
        p.set_volume(effective_output_volume(&state, vol));
    }
}

#[tauri::command]
pub fn audio_is_playing(state: tauri::State<'_, AudioState>) -> bool {
    state
        .player
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| !p.is_paused() && !p.empty())
        .unwrap_or(false)
}

#[tauri::command]
pub fn audio_set_metadata(
    title: String,
    artist: String,
    cover_url: Option<String>,
    duration_secs: f64,
    state: tauri::State<'_, AudioState>,
) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetMetadata {
            title,
            artist,
            cover_url,
            duration_secs,
        })
        .ok();
    }
}

#[tauri::command]
pub fn audio_set_playback_state(playing: bool, state: tauri::State<'_, AudioState>) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetPlaying(playing)).ok();
    }
}

#[tauri::command]
pub fn audio_set_media_position(position: f64, state: tauri::State<'_, AudioState>) {
    if let Some(tx) = state.media_tx.lock().unwrap().as_ref() {
        tx.send(MediaCmd::SetPosition(position)).ok();
    }
}

/* ── Audio Device Management ──────────────────────────────── */

/// Audio sink info from PulseAudio/PipeWire
#[derive(serde::Serialize, Clone)]
pub struct AudioSink {
    pub name: String, // internal name for pactl
    pub display_name: String,
    pub description: String, // human-readable
    pub is_default: bool,
}

#[tauri::command]
pub fn audio_list_devices() -> Vec<AudioSink> {
    #[cfg(target_os = "linux")]
    {
        audio_list_devices_pactl()
    }
    #[cfg(not(target_os = "linux"))]
    {
        audio_list_devices_cpal()
    }
}

/// Linux: pactl returns clean PipeWire/PulseAudio sinks (no ALSA plugin spam)
#[cfg(target_os = "linux")]
fn audio_list_devices_pactl() -> Vec<AudioSink> {
    let output = match std::process::Command::new("pactl")
        .args(["--format=json", "list", "sinks"])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };

    let default_sink = std::process::Command::new("pactl")
        .args(["get-default-sink"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let sinks: Vec<serde_json::Value> = match serde_json::from_slice(&output) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    sinks
        .iter()
        .filter_map(|s| {
            let name = s.get("name")?.as_str()?.to_string();
            let description = s.get("description")?.as_str()?.to_string();
            Some(AudioSink {
                is_default: name == default_sink,
                name,
                display_name: description.clone(),
                description,
            })
        })
        .collect()
}

/// Windows/macOS: cpal returns clean device list
#[cfg(not(target_os = "linux"))]
fn audio_list_devices_cpal() -> Vec<AudioSink> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let default_id = host
        .default_output_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());

    let devices = match host.output_devices() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    devices
        .filter_map(|dev| {
            let id = dev.id().ok()?.to_string();
            #[allow(deprecated)]
            let display_name = dev.name().ok().unwrap_or_else(|| id.clone());
            let description = dev
                .description()
                .ok()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|| display_name.clone());
            Some(AudioSink {
                is_default: default_id.as_deref() == Some(id.as_str()),
                name: id,
                display_name,
                description,
            })
        })
        .collect()
}

#[tauri::command]
pub fn audio_switch_device(
    device_name: Option<String>,
    state: tauri::State<'_, AudioState>,
) -> Result<(), String> {
    // On Linux, set PipeWire/PulseAudio default sink first, then reopen default cpal device.
    // On other platforms, open the cpal device directly by id.
    #[cfg(target_os = "linux")]
    let switch_name: Option<String> = {
        if let Some(ref name) = device_name {
            std::process::Command::new("pactl")
                .args(["set-default-sink", name])
                .status()
                .map_err(|e| format!("pactl failed: {}", e))?;
        }
        None // always reopen default — pactl already switched it
    };
    #[cfg(not(target_os = "linux"))]
    let switch_name: Option<String> = device_name;

    // Stop current playback
    {
        let mut player = state.player.lock().unwrap();
        if let Some(old) = player.take() {
            old.stop();
        }

        let mut crossfade_player = state.crossfade_player.lock().unwrap();
        if let Some(old) = crossfade_player.take() {
            old.stop();
        }

        state.has_track.store(false, Ordering::Relaxed);
        state.load_gen.fetch_add(1, Ordering::Relaxed);
    }

    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state
        .audio_tx
        .send(AudioThreadCmd::SwitchDevice {
            name: switch_name,
            reply: reply_tx,
        })
        .map_err(|e| e.to_string())?;

    let new_mixer = reply_rx
        .recv_timeout(Duration::from_secs(4))
        .map_err(|e| format!("Device switch timed out: {}", e))?
        .map_err(|e| e)?;

    *state.mixer.lock().unwrap() = new_mixer;
    Ok(())
}

/* ── Track Download ───────────────────────────────────────── */

#[tauri::command]
pub async fn save_track_to_path(cache_path: String, dest_path: String) -> Result<String, String> {
    tokio::fs::copy(&cache_path, &dest_path)
        .await
        .map_err(|e| format!("Copy failed: {}", e))?;
    Ok(dest_path)
}

/* ── Visualizer Thread ────────────────────────────────────── */

pub fn start_visualizer_thread(app: &AppHandle) {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(2);

    let state = app.state::<AudioState>();
    *state.visualizer_tx.lock().unwrap() = Some(tx);

    std::thread::Builder::new()
        .name("audio-visualizer".into())
        .spawn(move || {
            let mut last_emit_at = std::time::Instant::now() - Duration::from_millis(120);
            let mut planner = FftPlanner::new();
            let fft = planner.plan_fft_forward(FFT_SIZE);
            let mut complex_buffer = vec![Complex { re: 0.0, im: 0.0 }; FFT_SIZE];
            let mut window = vec![0.0f32; FFT_SIZE];

            use std::f32::consts::PI;
            for i in 0..FFT_SIZE {
                window[i] = 0.5 * (1.0 - (2.0 * PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos());
            }

            while let Ok(samples) = rx.recv() {
                let state = handle.state::<AudioState>();
                if !state.window_visible.load(Ordering::Relaxed) {
                    continue;
                }
                if last_emit_at.elapsed() < Duration::from_millis(current_event_interval_ms(&state))
                {
                    continue;
                }

                let mut is_silent = true;
                for i in 0..FFT_SIZE {
                    let s = samples[i];
                    if s.abs() > 0.001 {
                        is_silent = false;
                    }
                    complex_buffer[i] = Complex {
                        re: s * window[i],
                        im: 0.0,
                    };
                }

                if is_silent {
                    last_emit_at = std::time::Instant::now();
                    handle.emit("audio:visualizer", vec![0u8; 64]).ok();
                    continue;
                }

                fft.process(&mut complex_buffer);

                let mut bins = vec![0u8; 64];
                let max_freq: f32 = 20000.0;
                let sample_rate: f32 = 48000.0;

                for i in 0..64 {
                    let min_f = 20.0f32 * (max_freq / 20.0f32).powf(i as f32 / 64.0);
                    let max_f = 20.0f32 * (max_freq / 20.0f32).powf((i + 1) as f32 / 64.0);

                    let min_idx = ((min_f / sample_rate) * FFT_SIZE as f32) as usize;
                    let max_idx = ((max_f / sample_rate) * FFT_SIZE as f32) as usize;
                    let min_idx = min_idx.max(1).min(FFT_SIZE / 2 - 1);
                    let max_idx = max_idx.max(min_idx + 1).min(FFT_SIZE / 2);

                    let mut sum = 0.0;
                    for j in min_idx..max_idx {
                        let c = complex_buffer[j];
                        sum += (c.re * c.re + c.im * c.im).sqrt();
                    }
                    let avg = sum / (max_idx - min_idx).max(1) as f32;

                    // Low frequencies carry much more raw energy than mids/highs.
                    // Apply a gentle spectral tilt and logarithmic compression so
                    // bass stays punchy but no longer dwarfs the rest of the band map.
                    let norm = i as f32 / 63.0;
                    let freq_weight = 0.22 + 0.78 * norm.powf(0.72);
                    let compensated = avg * freq_weight;
                    let compressed = (1.0f32 + compensated * 0.045f32).ln()
                        / (1.0f32 + 255.0f32 * 0.045f32).ln();
                    let val = (compressed * 255.0).clamp(0.0, 255.0) as u8;
                    bins[i] = val;
                }

                last_emit_at = std::time::Instant::now();
                handle.emit("audio:visualizer", bins).ok();
            }
        })
        .expect("failed to spawn visualizer thread");
}
