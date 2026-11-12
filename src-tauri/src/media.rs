//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::http::{Response, StatusCode};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
/// Linux 走 loopback HTTP：WebKitGTK 的播放器是 GStreamer，它拿不到自定义 scheme。
#[cfg(target_os = "linux")]
pub const LOCAL_ORIGIN: &str = crate::linux_http::ORIGIN;
#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

static IMG_CACHE: Lazy<Mutex<HashMap<String, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PL_CACHE: Lazy<Mutex<HashMap<String, Arc<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// AES Key / 分片：拖进度条时同一 key、同一片会被反复拉，缓存住省一次往返。
static KEY_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const IMG_CACHE_MAX: usize = 240;
const PL_CACHE_MAX: usize = 60;
const KEY_CACHE_MAX: usize = 120;
const SEG_CACHE_MAX: usize = 36;
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

fn cache_put<V: Clone>(map: &Mutex<HashMap<String, V>>, key: String, val: V, max: usize) {
    let mut m = map.lock().unwrap();
    if m.len() >= max {
        if let Some(k) = m.keys().next().cloned() {
            m.remove(&k);
        }
    }
    m.insert(key, val);
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 取封面：命中缓存直接返回，否则下载并按需解密。
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(url).cloned() {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    let arc = Arc::new(plain);
    cache_put(&IMG_CACHE, url.to_string(), arc.clone(), IMG_CACHE_MAX);
    Ok((kind, arc))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// 取 m3u8 并把 key / 分片地址改写到本地协议。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    // 缓存 key 要带 prefix：同一份 m3u8 在不同 scheme 下改写结果不一样
    let cache_key = format!("{prefix}|{url}");
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    let arc = Arc::new(rewrite_playlist(url, text, prefix));
    // 没有 ENDLIST 的是仍在增长的直播 / 边切边播列表：缓存会让它永远停在旧版本，不缓存
    if text.contains("#EXT-X-ENDLIST") {
        cache_put(&PL_CACHE, cache_key, arc.clone(), PL_CACHE_MAX);
    }
    Ok(arc)
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// 分片 / AES Key 带内存缓存：拖动进度条时避免重复拉取同一片造成卡顿。
pub async fn load_segment(url: &str) -> Result<(Option<String>, Arc<Vec<u8>>), String> {
    if let Some((ctype, hit)) = KEY_CACHE.lock().unwrap().get(url).cloned() {
        return Ok((Some(ctype), hit));
    }
    if let Some((ctype, hit)) = SEG_CACHE.lock().unwrap().get(url).cloned() {
        return Ok((Some(ctype), hit));
    }
    let (ctype, bytes) = fetch_bytes(url).await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let len = bytes.len();
    let arc = Arc::new(bytes);
    if len <= 65536 {
        cache_put(&KEY_CACHE, url.to_string(), (mime.clone(), arc.clone()), KEY_CACHE_MAX);
    } else if len <= SEG_CACHE_MAX_BYTES {
        cache_put(&SEG_CACHE, url.to_string(), (mime.clone(), arc.clone()), SEG_CACHE_MAX);
    }
    Ok((Some(mime), arc))
}

/// 清空封面 / 播放列表 / Key / 分片内存缓存
pub fn clear_caches() {
    if let Ok(mut g) = IMG_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = PL_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = KEY_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_CACHE.lock() {
        g.clear();
    }
}

/* ───────────────────────── Range（mp4 直连播放） ───────────────────────── */
//
// 原生 <video> 经自定义协议读 mp4：WebKit 会发大量很小的 Range（几百字节~几 KB，探测 moov / 逐段取样），
// 拖动进度条还会跳到任意位置。做法是 1MB 对齐的块缓存：
//   - 任意区间都由块拼出，小请求命中缓存只要 1 毫秒；
//   - 缺的块并发向上游取（网络盘首字节慢，并发能把延迟摊平）；
//   - 顺序向前读时提前预读后面 READ_AHEAD 块，顺序播放不断档；
//   - 拖动（非顺序）后的第一次响应只给 1MB，画面更早出来。

const BLOCK: u64 = 1024 * 1024;
/// 顺序读取时单次响应的上限（浏览器对 `bytes=N-` 会等整段，不能真拉到文件末尾，回短块它会接着请求）。
const RESP_SEQ: u64 = 4 * BLOCK;
/// 拖动后第一次响应的上限：小块首字节更快。
const RESP_SEEK: u64 = BLOCK;
/// 顺序播放时向前预读的块数。
const READ_AHEAD: u64 = 8;
const BLOCK_CACHE_MAX: usize = 200; // ≈200MB

static BLOCKS: Lazy<Mutex<HashMap<String, (u64, Arc<Vec<u8>>)>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// 每个源的 (文件总长, Content-Type)
static META: Lazy<Mutex<HashMap<String, (u64, String)>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static PENDING: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
/// 每个源最近一次响应的末尾字节：用来区分顺序播放和拖动。
static LAST_END: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static BLOCK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn block_get(key: &str) -> Option<Arc<Vec<u8>>> {
    let seq = BLOCK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    BLOCKS.lock().unwrap().get_mut(key).map(|(s, v)| { *s = seq; v.clone() })
}

fn block_put(key: String, data: Arc<Vec<u8>>) {
    let mut m = BLOCKS.lock().unwrap();
    if m.len() >= BLOCK_CACHE_MAX && !m.contains_key(&key) {
        if let Some(old) = m.iter().min_by_key(|(_, (seq, _))| *seq).map(|(k, _)| k.clone()) {
            m.remove(&old);
        }
    }
    let seq = BLOCK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    m.insert(key, (seq, data));
}

/// 解析 `bytes=a-b` / `bytes=a-` / `bytes=-n`；多段 Range 不支持。
#[derive(Debug, PartialEq, Eq)]
enum ByteRange {
    From { start: u64, end: Option<u64> },
    Suffix(u64),
}

fn parse_range(header: &str) -> Option<ByteRange> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    match (a.trim(), b.trim()) {
        ("", "") => None,
        ("", n) => n.parse().ok().map(ByteRange::Suffix),
        (s, "") => s.parse().ok().map(|start| ByteRange::From { start, end: None }),
        (s, e) => {
            let (start, end): (u64, u64) = (s.parse().ok()?, e.parse().ok()?);
            (end >= start).then_some(ByteRange::From { start, end: Some(end) })
        }
    }
}

/// 实际响应的末尾字节：不超过请求、不超过文件末尾、不超过本次上限。
fn clamp_end(start: u64, end_req: u64, total: u64, cap: u64) -> u64 {
    end_req.min(total.saturating_sub(1)).min(start.saturating_add(cap - 1))
}

/// 是不是需要按 Range 直连的原文件（HLS 分片 / key 不走这条路）。
fn is_progressive_media(url: &str) -> bool {
    let p = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    [".mp4", ".m4v", ".mov", ".webm"].iter().any(|ext| p.ends_with(ext))
}

fn respond_range(status: u16, ctype: &str, content_range: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    let mut b = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::PARTIAL_CONTENT))
        .header("Content-Type", ctype)
        .header("Content-Length", len)
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
    if !content_range.is_empty() {
        b = b.header("Content-Range", content_range);
    }
    b.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

/// `Content-Range: bytes a-b/total` → total
fn parse_total(cr: &str) -> Option<u64> {
    cr.trim().strip_prefix("bytes ")?.split_once('/')?.1.trim().parse().ok()
}

async fn fetch_block(url: &str, idx: u64) -> Result<Arc<Vec<u8>>, String> {
    let range = format!("bytes={}-{}", idx * BLOCK, (idx + 1) * BLOCK - 1);
    let r = crate::net::fetch_range(url, &range).await?;
    if r.status == 416 {
        return Err("416".into());
    }
    if let Some(total) = r.content_range.as_deref().and_then(parse_total) {
        META.lock().unwrap().insert(url.to_string(), (total, r.content_type.clone().unwrap_or_else(|| "video/mp4".into())));
    }
    let data = Arc::new(r.bytes);
    block_put(format!("{url}|{idx}"), data.clone());
    Ok(data)
}

/// 取一块：命中缓存直接返回；别人（预读）正在取同一块就等它；否则自己取。
async fn get_block(url: &str, idx: u64) -> Result<Arc<Vec<u8>>, String> {
    let key = format!("{url}|{idx}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    loop {
        if let Some(hit) = block_get(&key) {
            return Ok(hit);
        }
        if PENDING.lock().unwrap().insert(key.clone()) {
            let result = fetch_block(url, idx).await;
            PENDING.lock().unwrap().remove(&key);
            return result;
        }
        if std::time::Instant::now() > deadline {
            return Err("等待媒体块超时".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    }
}

fn prefetch_blocks(url: &str, from: u64, total: u64) {
    let blocks = total.div_ceil(BLOCK);
    for idx in from..(from + READ_AHEAD).min(blocks) {
        let key = format!("{url}|{idx}");
        if BLOCKS.lock().unwrap().contains_key(&key) || PENDING.lock().unwrap().contains(&key) {
            continue;
        }
        let url = url.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = get_block(&url, idx).await;
        });
    }
}

async fn range_response(url: &str, range_header: &str) -> Response<Vec<u8>> {
    let Some(range) = parse_range(range_header) else {
        return respond(416, "text/plain", b"bad range".to_vec(), "no-store");
    };
    let fail = |e: String| respond(502, "text/plain", e.into_bytes(), "no-store");
    // 先拿到文件总长（第一次请求会顺带取第 0 块）
    let mut meta = META.lock().unwrap().get(url).cloned();
    if meta.is_none() {
        if let Err(e) = get_block(url, 0).await {
            return fail(e);
        }
        meta = META.lock().unwrap().get(url).cloned();
    }
    let Some((total, ctype)) = meta else {
        return fail("上游没有给出文件总长度".into());
    };
    let (start, end_req, from_range) = match range {
        ByteRange::From { start, end } => (start, end.unwrap_or(u64::MAX), true),
        ByteRange::Suffix(n) => (total.saturating_sub(n.min(total)), u64::MAX, false),
    };
    if start >= total {
        return respond_range(416, "text/plain", &format!("bytes */{total}"), Vec::new());
    }
    // 从上次结束位置往前不远处接着读 = 顺序播放；否则是拖动 / 探测
    let forward = from_range
        && LAST_END.lock().unwrap().get(url).is_some_and(|end| start > *end && start - *end <= 2 * BLOCK || start == *end + 1);
    let end = clamp_end(start, end_req, total, if forward { RESP_SEQ } else { RESP_SEEK });
    let (first, last) = (start / BLOCK, end / BLOCK);

    // 缺的块并发取
    let handles: Vec<_> = (first..=last)
        .map(|idx| {
            let url = url.to_string();
            tauri::async_runtime::spawn(async move { get_block(&url, idx).await })
        })
        .collect();
    let mut body = Vec::with_capacity((end - start + 1) as usize);
    for (idx, handle) in (first..=last).zip(handles) {
        let block = match handle.await {
            Ok(Ok(b)) => b,
            Ok(Err(e)) if e == "416" => return respond_range(416, "text/plain", &format!("bytes */{total}"), Vec::new()),
            Ok(Err(e)) => return fail(e),
            Err(e) => return fail(e.to_string()),
        };
        let base = idx * BLOCK;
        let lo = (start.max(base) - base) as usize;
        let hi = ((end + 1).min(base + BLOCK) - base) as usize;
        if lo >= block.len() {
            return fail("上游返回的数据比声明的短".into());
        }
        body.extend_from_slice(&block[lo..hi.min(block.len())]);
    }

    if from_range {
        let mut last_end = LAST_END.lock().unwrap();
        if last_end.len() > 16 { last_end.clear(); }
        last_end.insert(url.to_string(), end);
        drop(last_end);
        // 顺序读取 / 从文件开头开始读：预读后面几块，起播和连续播放都不断档
        if forward || start == 0 {
            prefetch_blocks(url, last + 1, total);
        }
    }
    respond_range(206, &ctype, &format!("bytes {start}-{end}/{total}"), body)
}

/* ───────────────────────── 协议响应 ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        // WKWebView 需要 Content-Length / Accept-Ranges 才肯复用已缓冲的分片
        .header("Content-Length", len)
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        return match std::str::from_utf8(&bytes) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                // Rewriting nested URIs does not require disabling the upstream cache policy.
                "public, max-age=3600",
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    respond(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        "public, max-age=3600",
    )
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(path: &str, query: &str, origin: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => {
                respond(200, &kind, bytes.as_ref().clone(), "public, max-age=86400")
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" if range.is_some() && is_progressive_media(&target) => range_response(&target, range.unwrap_or_default()).await,
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => segment_response(&target, ctype.as_deref(), bytes.as_ref().clone(), origin),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        // Linux 上 LOCAL_ORIGIN 本身就是 `http://127.0.0.1:<port>`，
        // 所以不能断言「不含 127.0.0.1」，要断言上游那条 key 地址已被代理包起来
        assert!(!body.contains("URI=\"http://127.0.0.1/key\""));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖上游 `/api/videos/117/play` 返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUBX_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUBX_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = std::env::var("HGHUBX_TEST_COVER_URL")
            .expect("需要设置 HGHUBX_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }

    #[test]
    fn range_parsing_and_clamping() {
        assert_eq!(parse_range("bytes=0-"), Some(ByteRange::From { start: 0, end: None }));
        assert_eq!(parse_range("bytes=10-19"), Some(ByteRange::From { start: 10, end: Some(19) }));
        assert_eq!(parse_range("bytes=-500"), Some(ByteRange::Suffix(500)));
        assert_eq!(parse_range("bytes=0-1,5-9"), None);
        assert_eq!(parse_range("bytes=9-3"), None);
        assert_eq!(parse_range("items=0-1"), None);
        let total = 100 * BLOCK;
        // 开放区间被裁到本次上限；小请求原样；不越过文件末尾
        assert_eq!(clamp_end(100, u64::MAX, total, RESP_SEQ), 100 + RESP_SEQ - 1);
        assert_eq!(clamp_end(100, u64::MAX, total, RESP_SEEK), 100 + RESP_SEEK - 1);
        assert_eq!(clamp_end(0, 1, total, RESP_SEQ), 1);
        assert_eq!(clamp_end(total - 10, u64::MAX, total, RESP_SEQ), total - 1);
    }

    #[test]
    fn content_range_total_and_progressive_detection() {
        assert_eq!(parse_total("bytes 0-1048575/1000000000"), Some(1000000000));
        assert_eq!(parse_total("bytes */1000"), Some(1000));
        assert_eq!(parse_total("garbage"), None);
        assert!(is_progressive_media("http://192.168.1.2:8080/media/file/1/1.mp4?x=1"));
        assert!(!is_progressive_media("http://192.168.1.2:8080/media/hls/1/1/seg_00001.ts"));
        assert!(!is_progressive_media("http://h/index.m3u8"));
    }
}
