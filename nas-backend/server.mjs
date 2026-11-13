#!/usr/bin/env node
// HGhubX NAS 后端：把本地影片目录包装成 HGhubX 的 edge_v1 接口。零依赖，Node >= 18，需要 ffmpeg/ffprobe。
//
// 用法：  node server.mjs /path/to/media [--port 8080] [--cache ./cache] [--cache-max-gb 20]
// 目录约定（按 NAS 内容自动分类）：
//   <媒体目录>/<分类>/…/xxx.mp4   每个视频文件是一个条目；顶层文件夹名 = 分类，更深的子文件夹名 = 额外标签
//   <媒体目录>/xxx.mp4            散放在根目录的视频归入「其他」
//   封面：与视频同名的 .jpg/.png/.webp；没有则用 ffmpeg 截一帧（后台预生成，缓存到磁盘）
// 客户端「接入地址」填 http://<NAS-IP>:8080

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSubtitles } from "./subtitles.mjs";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const MEDIA_DIR = path.resolve(argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--")) || process.env.MEDIA_DIR || "./media");
const PORT = Number(opt("port", process.env.PORT || 8080));
const CACHE_DIR = path.resolve(opt("cache", process.env.CACHE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), "cache")));
// 字幕组件（whisper 模型 / 翻译模型 / Python 环境）所在目录，由 setup-subtitles.sh 安装
const MODELS_DIR = path.resolve(opt("models-dir", process.env.MODELS_DIR || path.join(CACHE_DIR, "models")));
const CACHE_MAX_BYTES = Number(opt("cache-max-gb", process.env.CACHE_MAX_GB || 20)) * 1024 ** 3;
const HLS_TIME = 6; // 转码时的分片秒数；拷贝流时由源文件关键帧间隔决定
const VIDEO_EXT = new Set([".mp4", ".mkv", ".mov", ".avi", ".ts", ".m4v", ".webm", ".flv", ".wmv", ".rmvb"]);
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];
const OTHER = "其他";

fs.mkdirSync(path.join(CACHE_DIR, "hls"), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, "covers"), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 简单信号量：限制对网络盘的并发读 */
const sem = (max) => {
  let running = 0; const q = [];
  return {
    get busy() { return running > 0 || q.length > 0; },
    async run(fn) {
      if (running >= max) await new Promise((r) => q.push(r));
      else running++;
      try { return await fn(); } finally { const n = q.shift(); if (n) n(); else running--; }
    },
  };
};
const coverSem = sem(3);   // 截封面
const probeSem = sem(4);   // ffprobe

/* ───────────── 媒体库扫描（异步，不阻塞请求） ───────────── */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const stableId = (rel) => crypto.createHash("sha1").update(rel).digest().readUInt32BE(0) % 2_000_000_000 + 1;
const FILE_STAT = new Map(); // file -> { size, mtimeMs }

async function walk(dir, rel, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { console.warn("skip", dir, e.message); return; }
  const names = new Set(entries.map((e) => e.name));
  const jobs = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jobs.push(walk(p, [...rel, e.name], out));
    else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      jobs.push((async () => {
        const st = await fsp.stat(p).catch(() => null);
        if (!st) return;
        const stem = path.basename(e.name, path.extname(e.name));
        const side = IMAGE_EXT.map((x) => stem + x).find((n) => names.has(n));
        FILE_STAT.set(p, { size: st.size, mtimeMs: st.mtimeMs });
        out.push({
          id: stableId([...rel, e.name].join("/")), title: stem, files: [p], mtime: st.mtimeMs,
          category: rel[0] || OTHER, tags: [rel[0] || OTHER, ...rel.slice(1)], score: 0, description: "",
          coverFile: side ? path.join(dir, side) : null,
        });
      })());
    }
    // 每批并发有限，避免对 AFP 一次发起上千个 stat
    if (jobs.length >= 16) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
}

let LIBRARY = { list: [], byId: new Map(), categories: [], version: "", scannedAt: 0 };
let scanning = null;
let suspect = 0; // 连续几次扫描结果异常（骤降）
const libraryVersion = (list) => crypto.createHash("sha1").update(list.map((v) => v.id).sort((a, b) => a - b).join(",")).digest("hex").slice(0, 12);
const libraryStatus = () => ({ version: LIBRARY.version, count: LIBRARY.list.length, categories: LIBRARY.categories.length, scannedAt: LIBRARY.scannedAt, scanning: !!scanning });

/** 扫描片库。同时只跑一个；正在扫时返回同一个 Promise。
 *  网络盘暂时断开 / 某个子目录读不出来时，扫描结果会是空的或骤降——这种情况保留旧片库，连续两次都这样才接受。 */
function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const t0 = Date.now();
    try {
      await fsp.access(MEDIA_DIR); // 根目录读不到（共享没挂载）直接抛错，保留旧片库
      const found = [];
      await walk(MEDIA_DIR, [], found);
      const prev = LIBRARY.list.length;
      if (prev > 0 && (found.length === 0 || found.length < prev * 0.5) && suspect < 1) {
        suspect++;
        console.warn(`[scan] 结果异常（${prev} → ${found.length}），可能是网络盘暂时不可用，先保留旧片库，下次再确认`);
        return;
      }
      suspect = 0;
      const used = new Set();
      found.sort((a, b) => b.mtime - a.mtime || collator.compare(a.title, b.title));
      for (const v of found) { while (used.has(v.id)) v.id++; used.add(v.id); }
      const cats = new Map();
      for (const v of found) { const c = cats.get(v.category) || { name: v.category, count: 0, latest: 0 }; c.count++; c.latest = Math.max(c.latest, v.mtime); cats.set(v.category, c); }
      const before = LIBRARY.version;
      LIBRARY = { list: found, byId: new Map(found.map((v) => [v.id, v])), categories: [...cats.values()].sort((a, b) => b.latest - a.latest), version: libraryVersion(found), scannedAt: Date.now() };
      console.log(`[scan] ${found.length} 个视频 / ${cats.size} 个分类 @ ${MEDIA_DIR} (${Date.now() - t0}ms)${before && before !== LIBRARY.version ? "，片库有变化" : ""}`);
    } catch (e) {
      console.warn(`[scan] 失败，保留旧片库：${e.message || e}`);
    } finally { scanning = null; }
  })();
  return scanning;
}

/* ───────────── ffprobe（结果持久化到磁盘，重启后不用再读网络盘） ───────────── */

const PROBE_FILE = path.join(CACHE_DIR, "probe.json");
let PROBES = {};
try { PROBES = JSON.parse(fs.readFileSync(PROBE_FILE, "utf8")); } catch {}
let probeDirty = false;
setInterval(() => { if (probeDirty) { probeDirty = false; fsp.writeFile(PROBE_FILE + ".tmp", JSON.stringify(PROBES)).then(() => fsp.rename(PROBE_FILE + ".tmp", PROBE_FILE)).catch(() => {}); } }, 15_000).unref();

const probeKey = (file) => { const s = FILE_STAT.get(file); return s ? `${file}|${s.size}|${Math.round(s.mtimeMs)}` : file; };
const cachedProbe = (file) => PROBES[probeKey(file)];
const probeJobs = new Map();
function probe(file) {
  const hit = cachedProbe(file);
  if (hit) return Promise.resolve(hit);
  if (!probeJobs.has(file)) {
    probeJobs.set(file, probeSem.run(async () => {
      const { stdout } = await execFileP("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 16e6 });
      const j = JSON.parse(stdout);
      const v = j.streams.find((s) => s.codec_type === "video");
      const a = j.streams.find((s) => s.codec_type === "audio");
      const r = { duration: Math.round(Number(j.format.duration) || 0), vcodec: v?.codec_name, acodec: a?.codec_name, pixfmt: v?.pix_fmt };
      PROBES[probeKey(file)] = r; probeDirty = true;
      return r;
    }).finally(() => probeJobs.delete(file)));
  }
  return probeJobs.get(file);
}

/** 能不能原文件直连播放：mp4/m4v/mov 容器 + H.264(yuv420p) + AAC/MP3，所有 WebView 都能硬解，
 *  靠 HTTP Range 拖动进度条，零等待、不占缓存。其余（mkv/avi/HEVC/AC3…）才封装成 HLS。 */
const DIRECT_EXT = new Set([".mp4", ".m4v", ".mov"]);
function canDirectPlay(file, info) {
  return DIRECT_EXT.has(path.extname(file).toLowerCase()) && info.vcodec === "h264" &&
    (!info.pixfmt || info.pixfmt === "yuv420p") && (!info.acodec || info.acodec === "aac" || info.acodec === "mp3");
}

/* ───────────── 封面 ───────────── */

const coverJobs = new Map();
function coverPath(video) {
  if (video.coverFile) return Promise.resolve(video.coverFile);
  const out = path.join(CACHE_DIR, "covers", `${video.id}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!coverJobs.has(video.id)) {
    coverJobs.set(video.id, coverSem.run(async () => {
      const grab = (ss) => execFileP("ffmpeg", ["-y", "-v", "error", "-ss", String(ss), "-i", video.files[0], "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", out + ".tmp.jpg"]);
      try { await grab(8); } catch {}
      if (!fs.existsSync(out + ".tmp.jpg")) await grab(0); // 视频短于 8 秒
      await fsp.rename(out + ".tmp.jpg", out);
      return out;
    }).finally(() => coverJobs.delete(video.id)));
  }
  return coverJobs.get(video.id);
}

/* ───────────── HLS ───────────── */

/* 网络盘（AFP）读取速度是瓶颈（实测约 16MB/s）。策略：
 *  - 新的播放请求立刻启动 ffmpeg，不排队；
 *  - 只让「最近被请求的 ACTIVE 个」任务继续跑，更早的任务 SIGSTOP 暂停（不丢进度），腾出带宽给正在看的片子；
 *  - 任务结束或被再次请求时自动恢复。 */
const hlsJobs = new Map(); // key -> { promise, lastUsed, proc, paused, pausedAt }
const ACTIVE = 3;
function rebalance() {
  const list = [...hlsJobs.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  // 前台优先：最近被请求、还没切出起播段数的任务独占带宽，其余全部暂停；它开播后再恢复最近的 ACTIVE 个
  const fg = list.find((j) => j.foreground);
  list.forEach((j, i) => {
    if (!j.proc) return;
    const run = fg ? j === fg : i < ACTIVE;
    try {
      if (run && j.paused) { j.proc.kill("SIGCONT"); j.paused = false; }
      else if (!run && !j.paused) { j.proc.kill("SIGSTOP"); j.paused = true; j.pausedAt = Date.now(); }
    } catch {}
  });
}
setInterval(() => { // 暂停超过 15 分钟的任务视为被放弃，清理掉
  for (const j of hlsJobs.values()) if (j.paused && Date.now() - j.pausedAt > 15 * 60_000) { try { j.proc.kill("SIGKILL"); } catch {} }
}, 60_000).unref();

function runFfmpeg(args, job) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    job.proc = p;
    rebalance();
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${c}: ${err}`))));
  });
}
const readList = (m3u8) => { try { return fs.readFileSync(m3u8, "utf8"); } catch { return ""; } };
const isComplete = (m3u8) => readList(m3u8).includes("#EXT-X-ENDLIST");
const segCount = (m3u8) => (readList(m3u8).match(/^seg_\d+\.ts$/gm) || []).length;
const START_SEGMENTS = 3;            // 切出这么多段就先开播（边切边播；hls.js 直播起播需要约 3 段）
const SMALL_FILE = 48 * 1024 * 1024; // 小文件几秒内就能切完，值得多等一下直接给完整 VOD（可随意拖动）

/** 后台把一集封装成 HLS：H.264+AAC 直接拷贝流（不重编码），其它编码才转码。缓存在磁盘。 */
async function ensureHls(video, ep = 1) {
  const dir = path.join(CACHE_DIR, "hls", String(video.id), String(ep));
  const m3u8 = path.join(dir, "index.m3u8");
  const key = `${video.id}/${ep}`;
  let job = hlsJobs.get(key);
  if (job) { job.lastUsed = Date.now(); if (segCount(m3u8) < START_SEGMENTS) job.foreground = true; rebalance(); }
  else {
    if (isComplete(m3u8)) { fsp.utimes(dir, new Date(), new Date()).catch(() => {}); return; }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    job = { lastUsed: Date.now(), proc: null, paused: false, foreground: true };
    rebalance();
    hlsJobs.set(key, job);
    job.promise = (async () => {
      const file = video.files[ep - 1];
      const info = await probe(file);
      const copyV = info.vcodec === "h264" && (!info.pixfmt || info.pixfmt === "yuv420p");
      const copyA = !info.acodec || info.acodec === "aac";
      console.log(`[hls] ${video.category}/${video.title} video=${copyV ? "copy" : "x264"} audio=${copyA ? "copy" : "aac"}`);
      await runFfmpeg([
        "-y", "-v", "error", "-fflags", "+genpts", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-sn",
        ...(copyV ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-force_key_frames", `expr:gte(t,n_forced*${HLS_TIME})`]),
        ...(copyA ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k", "-ac", "2"]),
        "-f", "hls", "-hls_time", String(HLS_TIME), "-hls_playlist_type", "event", "-hls_flags", "temp_file",
        "-hls_segment_type", "mpegts", "-hls_segment_filename", path.join(dir, "seg_%05d.ts"), m3u8,
      ], job);
    })();
    job.promise.then(() => evictSoon(), (e) => { console.error(`[hls] ${key} 失败:`, e.message); fs.rmSync(dir, { recursive: true, force: true }); })
      .finally(() => { hlsJobs.delete(key); rebalance(); });
  }
  let finished = false;
  job.promise.then(() => { finished = true; }, () => { finished = true; });
  const small = (FILE_STAT.get(video.files[ep - 1])?.size || Infinity) <= SMALL_FILE;
  const t0 = Date.now();
  for (; !finished && Date.now() - t0 < 120_000; await sleep(80)) {
    if (segCount(m3u8) >= START_SEGMENTS && (!small || Date.now() - t0 > 4000)) break;
  }
  if (job.foreground) { job.foreground = false; rebalance(); }
  if (!fs.existsSync(m3u8)) throw new Error("生成播放列表失败或超时");
}

/** HLS 缓存超过上限时，按最近使用时间淘汰最旧的（正在生成的不动） */
let evictTimer = null;
function evictSoon() { if (!evictTimer) evictTimer = setTimeout(() => { evictTimer = null; evict().catch(() => {}); }, 30_000); }
async function dirSize(d) { let n = 0; for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p)).size; } return n; }
async function evict() {
  const root = path.join(CACHE_DIR, "hls");
  const eps = [];
  for (const id of await fsp.readdir(root)) for (const ep of await fsp.readdir(path.join(root, id)).catch(() => [])) {
    const d = path.join(root, id, ep);
    const st = await fsp.stat(d).catch(() => null);
    if (st?.isDirectory()) eps.push({ d, key: `${id}/${ep}`, t: st.mtimeMs, size: await dirSize(d).catch(() => 0) });
  }
  let total = eps.reduce((s, e) => s + e.size, 0);
  for (const e of eps.sort((a, b) => a.t - b.t)) {
    if (total <= CACHE_MAX_BYTES) break;
    if (hlsJobs.has(e.key)) continue;
    await fsp.rm(e.d, { recursive: true, force: true });
    total -= e.size;
    console.log(`[cache] 淘汰 ${e.key}，剩余 ${(total / 1024 ** 3).toFixed(1)}GB`);
  }
}

/** 空闲时后台预生成时长与封面，让列表页和详情页都是命中缓存的瞬时响应 */
async function prewarm() {
  for (;;) {
    let did = false;
    for (const v of LIBRARY.list) {
      if (hlsJobs.size > 0 || coverSem.busy) { await sleep(2000); continue; } // 用户在播放 / 在刷列表时让路
      const f = v.files[0];
      try {
        if (!cachedProbe(f)) { await probe(f); did = true; await sleep(100); }
        if (!v.coverFile && !fs.existsSync(path.join(CACHE_DIR, "covers", `${v.id}.jpg`))) { await coverPath(v); did = true; await sleep(100); }
      } catch (e) { /* 坏文件跳过 */ }
    }
    await sleep(did ? 5_000 : 60_000);
  }
}

/* ───────────── 字幕（本地语音识别 + 翻译） ───────────── */

const subs = createSubtitles({
  cacheDir: CACHE_DIR,
  modelsDir: MODELS_DIR,
  fileOf: (id, ep) => LIBRARY.byId.get(id)?.files[ep - 1] || null,
  durationOf: (file) => probe(file).then((i) => i.duration),
});

/* ───────────── 数据映射 ───────────── */

const ok = (data) => ({ status: 1, data });
const fail = (msg) => ({ status: 0, msg });
const AUTHOR = { id: 1, name: "NAS", avatar: null, followers: 0 };
const USER = { id: 1, username: "nas", nickname: "NAS", avatar: "", avatar_color: "#0b6e99", counts: {} };
const durText = (s) => (s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");

function card(v, base) {
  const info = cachedProbe(v.files[0]);
  return {
    id: v.id, title: v.title, cover: `${base}/media/cover/${v.id}.jpg`, description: v.description, tags: v.tags,
    score: v.score, episode_count: 1, total_episodes: 1, duration: info ? durText(info.duration) : undefined, hot: 0, like_count: 0,
    collect_count: 0, comment_count: 0, is_finished: true, is_original: 0,
    created_at: new Date(v.mtime).toISOString(), new_at: Math.floor(v.mtime / 1000), author: { ...AUTHOR, name: v.category },
  };
}
function paged(items, q, base) {
  const size = Math.min(Math.max(Number(q.get("size")) || 20, 1), 100);
  const page = Math.max(Number(q.get("page")) || 1, 1);
  return { items: items.slice((page - 1) * size, page * size).map((v) => card(v, base)), pagination: { page, size, total: items.length, pages: Math.ceil(items.length / size) } };
}
const emptyPage = (q) => ({ items: [], pagination: { page: Number(q.get("page")) || 1, size: Number(q.get("size")) || 20, total: 0, pages: 0 } });

async function detail(v, base) {
  const info = await probe(v.files[0]).catch(() => ({ duration: 0 }));
  return { video: { ...card(v, base), episodes: [{ ep_num: 1, title: v.title, duration: info.duration, status: 1 }], counts: { collect: 0, comment: 0, hot: 0, like: 0 }, interaction: { collected: false, liked: false }, duration: info.duration } };
}

/* ───────────── 路由（edge 信封里的 method + path） ───────────── */

async function route(method, rawPath, body, base) {
  const u = new URL(rawPath, "http://x");
  const p = u.pathname, q = u.searchParams;
  const all = LIBRARY.list;
  let m;

  if (p === "/api/account/loginByPassword" || p === "/api/account/registerByPassword")
    return ok({ token: crypto.randomBytes(16).toString("hex"), user: { ...USER, username: body?.username || "nas", nickname: body?.username || "NAS" } });
  if (p === "/api/account/logout") return ok({});
  if (p === "/api/account/me") return ok(USER);

  if (p === "/api/videos") return ok(paged(all, q, base));
  if ((m = p.match(/^\/api\/videos\/category\/(.+)$/))) { const c = decodeURIComponent(m[1]); return ok(paged(all.filter((v) => v.category === c || v.tags.includes(c)), q, base)); }
  if ((m = p.match(/^\/api\/videos\/tag\/(.+)$/))) { const t = decodeURIComponent(m[1]); return ok(paged(all.filter((v) => v.tags.includes(t)), q, base)); }
  if (p === "/api/videos/following") return ok(emptyPage(q));
  if (p.match(/^\/api\/videos\/user\/\d+$/)) return ok(paged(all, q, base));
  if ((m = p.match(/^\/api\/videos\/(\d+)\/related$/))) {
    const cur = LIBRARY.byId.get(+m[1]);
    return ok({ items: all.filter((v) => v.id !== +m[1] && cur && v.category === cur.category).slice(0, 12).map((v) => card(v, base)) });
  }
  if (p.match(/^\/api\/videos\/(\d+)\/comments$/)) return ok({ ep: 1, items: [], pagination: { page: 1, size: 20, total: 0, pages: 0 } });
  if (p.match(/^\/api\/videos\/(\d+)\/(like|collect)$/)) return ok({ liked: method !== "DELETE", collected: method !== "DELETE" });

  if ((m = p.match(/^\/api\/videos\/(\d+)\/episodes\/(\d+)\/playback$/)) || (m = p.match(/^\/api\/videos\/(\d+)\/play$/))) {
    const v = LIBRARY.byId.get(+m[1]);
    const ep = m[2] ? +m[2] : Number(q.get("ep")) || 1;
    if (!v || ep < 1 || ep > v.files.length) return fail("影片不存在");
    const file = v.files[ep - 1];
    const info = await probe(file).catch(() => null);
    if (!info) return fail("无法读取视频信息");
    let url;
    if (canDirectPlay(file, info)) url = `${base}/media/file/${v.id}/${ep}${path.extname(file).toLowerCase()}`;
    else { await ensureHls(v, ep); url = `${base}/media/hls/${v.id}/${ep}/index.m3u8`; }
    return ok({ id: v.id, ep_num: ep, duration: info.duration, title: v.title, video_url: url, streams: { main: url } });
  }
  if ((m = p.match(/^\/api\/videos\/(\d+)$/))) { const v = LIBRARY.byId.get(+m[1]); return v ? ok(await detail(v, base)) : fail("影片不存在"); }

  if (p === "/api/search") {
    if (q.get("type") === "post") return ok(emptyPage(q));
    const kw = (q.get("q") || "").toLowerCase();
    return ok({ ...paged(all.filter((v) => v.title.toLowerCase().includes(kw) || v.tags.some((t) => t.toLowerCase().includes(kw))), q, base), keyword: q.get("q") || "" });
  }
  if (p === "/api/search/hot") return ok({ items: LIBRARY.categories.slice(0, 8).map((c) => ({ word: c.name, heat: c.count })) });
  if ((m = p.match(/^\/api\/ranks\/(\w+)$/)))
    return ok({ type: m[1], items: all.slice(0, 20).map((v, i) => ({ rank: i + 1, video_id: v.id, title: v.title, cover: `${base}/media/cover/${v.id}.jpg`, tags: v.tags, score: v.score, cate_name: v.category, episode_count: 1, is_finished: true, metric_label: "", metric_value: 0, metrics: {} })) });
  if (p === "/api/tags") {
    // 分类 = 顶层文件夹；条目数放在 hot_score 里供客户端展示
    const groups = [{ id: 1, code: "category", name: "分类", sort: 0, tags: LIBRARY.categories.map((c, i) => ({ id: i + 1, name: c.name, slug: c.name, hot_score: c.count, sort: i })) }];
    return ok({ categories: groups });
  }
  if (p === "/api/topics") return ok({ items: [] });
  if (p.startsWith("/api/posts") || p === "/api/site/categories/post") return ok(p === "/api/site/categories/post" ? { items: [] } : emptyPage(q));
  if ((m = p.match(/^\/api\/users\/\d+(\/stats)?$/))) return ok(m[1] ? {} : USER);
  if (p.match(/^\/api\/users\/\d+\/follow$/)) return ok({ following: method !== "DELETE" });
  return fail(`未实现的接口: ${p}`);
}

/* ───────────── HTTP ───────────── */

function sendFile(req, res, file, ctype, extra = {}) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end("not found"); return; }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0, end = st.size - 1, code = 200;
  if (range) {
    if (range[1]) start = +range[1];
    if (range[2]) end = Math.min(+range[2], end);
    if (!range[1] && range[2]) { start = st.size - +range[2]; end = st.size - 1; }
    if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end(); return; }
    code = 206;
  }
  res.writeHead(code, {
    "Content-Type": ctype, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", ...extra,
    ...(code === 206 && { "Content-Range": `bytes ${start}-${end}/${st.size}` }),
  });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 });
  res.on("close", () => stream.destroy()); // 客户端拖动进度条会中断请求：立刻停读，别白白占用网络盘带宽
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host}`;
  const url = new URL(req.url, base);
  try {
    if (req.method === "POST" && url.pathname === "/api/edge/request") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const env = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      let body = null;
      if (env.body) try { body = JSON.parse(Buffer.from(env.body, "base64").toString()); } catch {}
      const t0 = Date.now();
      const out = await route((env.method || "GET").toUpperCase(), env.path || "/", body, base).catch((e) => { console.error(e); return fail(String(e.message || e)); });
      const ms = Date.now() - t0;
      if (ms > 500 || process.env.VERBOSE) console.log(`[api] ${env.method} ${env.path} -> ${out.status} ${ms}ms`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(out));
      return;
    }
    let m;
    if ((m = url.pathname.match(/^\/media\/cover\/(\d+)\.jpg$/))) {
      const v = LIBRARY.byId.get(+m[1]);
      if (!v) return void res.writeHead(404).end();
      const f = await coverPath(v);
      const ext = path.extname(f).toLowerCase();
      return sendFile(req, res, f, ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg", { "Cache-Control": "public, max-age=86400" });
    }
    if ((m = url.pathname.match(/^\/media\/file\/(\d+)\/(\d+)\.(mp4|m4v|mov)$/))) {
      const v = LIBRARY.byId.get(+m[1]);
      const file = v?.files[+m[2] - 1];
      if (!file) return void res.writeHead(404).end();
      return sendFile(req, res, file, m[3] === "mov" ? "video/quicktime" : "video/mp4", { "Cache-Control": "no-store" });
    }
    if ((m = url.pathname.match(/^\/media\/file\/(\d+)\/(\d+)\.(mp4|m4v|mov)$/))) {
      // 原文件直连：sendFile 支持 Range，客户端拖动进度条直接按字节取
      const v = LIBRARY.byId.get(+m[1]);
      const file = v?.files[+m[2] - 1];
      if (!file) return void res.writeHead(404).end();
      return sendFile(req, res, file, m[3] === "mov" ? "video/quicktime" : "video/mp4", { "Cache-Control": "no-store" });
    }
    if ((m = url.pathname.match(/^\/media\/hls\/(\d+)\/(\d+)\/(index\.m3u8|seg_\d+\.ts)$/))) {
      const file = path.join(CACHE_DIR, "hls", m[1], m[2], m[3]);
      const isList = m[3].endsWith(".m3u8");
      return sendFile(req, res, file, isList ? "application/vnd.apple.mpegurl" : "video/mp2t", { "Cache-Control": isList ? "no-store" : "public, max-age=86400, immutable" });
    }
    // 片库接口（GET + JSON）：客户端定期查 status，version 变了就刷新列表；ids 用来剔除已经不存在的视频
    if (url.pathname === "/library/status") return sendJson(res, libraryStatus());
    if (url.pathname === "/library/ids") return sendJson(res, { version: LIBRARY.version, ids: LIBRARY.list.map((v) => v.id) });
    if (url.pathname === "/library/refresh") { await scan(); return sendJson(res, libraryStatus()); }
    // 字幕接口：全是 GET + JSON，客户端经本地代理 /seg 访问
    if (url.pathname === "/sub/capabilities") return sendJson(res, subs.capabilities());
    if ((m = url.pathname.match(/^\/sub\/(\d+)\/(\d+)\/(status|start|cancel|remove|cues\.json)$/))) {
      const id = +m[1], ep = +m[2];
      if (!LIBRARY.byId.get(id)) return sendJson(res, { state: "error", message: "影片不存在" }, 404);
      switch (m[3]) {
        case "status": return sendJson(res, subs.status(id, ep));
        case "start": return sendJson(res, subs.start(id, ep, { lang: url.searchParams.get("lang") || "auto", force: url.searchParams.get("force") === "1" }));
        case "cancel": return sendJson(res, subs.cancel(id, ep));
        case "remove": return sendJson(res, subs.remove(id, ep));
        default: { const doc = subs.cues(id, ep); return doc ? sendJson(res, doc) : sendJson(res, { state: "idle" }, 404); }
      }
    }
    if (url.pathname === "/" || url.pathname === "/health") return void res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(`HGhubX NAS backend: ${LIBRARY.list.length} videos, ${LIBRARY.categories.length} categories\n`);
    res.writeHead(404).end("not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message || e));
  }
});
// 客户端（reqwest）会复用空闲连接；Node 默认 5 秒就关闭空闲连接，会撞上「复用到刚被关的连接」而失败重试，表现为偶发卡顿
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;

// 退出时带走所有 ffmpeg 子进程（被 SIGSTOP 暂停的也要杀掉，否则会变成孤儿进程一直占着文件）
const killJobs = () => { subs.shutdown(); for (const j of hlsJobs.values()) try { j.proc?.kill("SIGKILL"); } catch {} };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { killJobs(); process.exit(0); });
process.on("exit", killJobs);

// 由 HGhubX 应用拉起时：应用退出（包括崩溃）后自己也退出，避免留下孤儿进程
if (process.env.HGHUBX_PARENT_PID) {
  const parent = Number(process.env.HGHUBX_PARENT_PID);
  setInterval(() => { try { process.kill(parent, 0); } catch { killJobs(); process.exit(0); } }, 2000).unref();
}

await scan();
setInterval(() => scan().catch(console.error), 5 * 60 * 1000).unref(); // 网络盘上不监听目录变化，只定时重扫（5 分钟；扫描只读目录，不影响播放）
evictSoon();
prewarm().catch(console.error);
server.listen(PORT, "0.0.0.0", () => console.log(`[http] 监听 0.0.0.0:${PORT}，客户端接入地址填 http://<本机IP>:${PORT}`));
