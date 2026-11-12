#!/usr/bin/env node
// HGhubX NAS 后端：把本地影片目录包装成 HGhubX 的 edge_v1 接口。零依赖，Node >= 18，需要 ffmpeg/ffprobe。
//
// 用法：  node server.mjs /path/to/media [--port 8080] [--cache ./cache]
// 目录约定：
//   <媒体目录>/剧名/01.mp4 02.mp4 …   一个子文件夹 = 一部剧，里面的视频按文件名自然排序 = 各集
//   <媒体目录>/某电影.mkv              散放的视频文件 = 单集影片
//   封面：剧文件夹里放 cover/poster/folder.(jpg|png|webp)，电影放同名 .jpg；没有则用 ffmpeg 截一帧
//   可选 meta.json（剧文件夹内）：{"title","description","tags":[],"score":9.1}
// 客户端「接入地址」填 http://<NAS-IP>:8080

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const MEDIA_DIR = path.resolve(argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--")) || process.env.MEDIA_DIR || "./media");
const PORT = Number(opt("port", process.env.PORT || 8080));
const CACHE_DIR = path.resolve(opt("cache", process.env.CACHE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), "cache")));
const HLS_TIME = 6; // 分片秒数；客户端分片缓存上限 4MB，码率很高的片源可调小
const VIDEO_EXT = new Set([".mp4", ".mkv", ".mov", ".avi", ".ts", ".m4v", ".webm", ".flv", ".wmv", ".rmvb"]);
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];

fs.mkdirSync(path.join(CACHE_DIR, "hls"), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, "covers"), { recursive: true });

/* ───────────── 媒体库扫描 ───────────── */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const stableId = (rel) => crypto.createHash("sha1").update(rel).digest().readUInt32BE(0) % 2_000_000_000 + 1;

const isVideo = (f) => VIDEO_EXT.has(path.extname(f).toLowerCase());
function listVideos(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listVideos(p));
    else if (e.isFile() && isVideo(e.name)) out.push(p);
  }
  return out.sort((a, b) => collator.compare(path.relative(dir, a), path.relative(dir, b)));
}
function findCover(dir, stem) {
  for (const name of stem ? [stem] : ["cover", "poster", "folder"])
    for (const ext of IMAGE_EXT) { const p = path.join(dir, name + ext); if (fs.existsSync(p)) return p; }
  return null;
}

let LIBRARY = { list: [], byId: new Map() };
function scan() {
  const list = [];
  const used = new Set();
  const newId = (rel) => { let id = stableId(rel); while (used.has(id)) id++; used.add(id); return id; };
  for (const e of fs.readdirSync(MEDIA_DIR, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(MEDIA_DIR, e.name);
    let item = null;
    try {
      if (e.isDirectory()) {
        const files = listVideos(p);
        if (!files.length) continue;
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(p, "meta.json"), "utf8")); } catch {}
        item = {
          title: meta.title || e.name, description: meta.description || "", tags: meta.tags || ["剧集"], score: meta.score || 0,
          files, coverFile: findCover(p), mtime: Math.max(...files.map((f) => fs.statSync(f).mtimeMs)),
        };
      } else if (e.isFile() && isVideo(e.name)) {
        const stem = path.basename(e.name, path.extname(e.name));
        item = { title: stem, description: "", tags: ["电影"], score: 0, files: [p], coverFile: findCover(MEDIA_DIR, stem), mtime: fs.statSync(p).mtimeMs };
      }
    } catch (err) { console.warn("skip", p, err.message); }
    if (item) { item.id = newId(e.name); list.push(item); }
  }
  list.sort((a, b) => b.mtime - a.mtime);
  LIBRARY = { list, byId: new Map(list.map((v) => [v.id, v])) };
  console.log(`[scan] ${list.length} 部影片 @ ${MEDIA_DIR}`);
}

/* ───────────── ffprobe / 封面 / HLS ───────────── */

const probeCache = new Map();
async function probe(file) {
  if (probeCache.has(file)) return probeCache.get(file);
  const { stdout } = await execFileP("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 16e6 });
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const r = { duration: Math.round(Number(j.format.duration) || 0), vcodec: v?.codec_name, acodec: a?.codec_name, pixfmt: v?.pix_fmt };
  probeCache.set(file, r);
  return r;
}

const coverJobs = new Map();
async function coverPath(video) {
  if (video.coverFile) return video.coverFile;
  const out = path.join(CACHE_DIR, "covers", `${video.id}.jpg`);
  if (fs.existsSync(out)) return out;
  if (!coverJobs.has(video.id)) {
    coverJobs.set(video.id, (async () => {
      const file = video.files[0];
      const dur = (await probe(file).catch(() => ({ duration: 0 }))).duration;
      const at = Math.min(Math.max(dur * 0.1, 1), 120);
      await execFileP("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out + ".tmp.jpg"]);
      fs.renameSync(out + ".tmp.jpg", out);
    })().finally(() => coverJobs.delete(video.id)));
  }
  await coverJobs.get(video.id);
  return out;
}

const hlsJobs = new Map();
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${c}: ${err}`))));
  });
}
/** 第一次播放时把整集封装成 HLS（H.264+AAC 直接拷贝流，不重编码；其它编码才转码），结果缓存在磁盘。 */
async function ensureHls(video, ep) {
  const dir = path.join(CACHE_DIR, "hls", String(video.id), String(ep));
  const m3u8 = path.join(dir, "index.m3u8");
  if (fs.existsSync(m3u8)) return m3u8;
  const key = `${video.id}/${ep}`;
  if (!hlsJobs.has(key)) {
    hlsJobs.set(key, (async () => {
      const file = video.files[ep - 1];
      const info = await probe(file);
      const copyV = info.vcodec === "h264" && (!info.pixfmt || info.pixfmt === "yuv420p");
      const copyA = !info.acodec || info.acodec === "aac";
      const tmp = dir + ".tmp";
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      console.log(`[hls] ${video.title} 第${ep}集 video=${copyV ? "copy" : "x264"} audio=${copyA ? "copy" : "aac"}`);
      await runFfmpeg([
        "-y", "-v", "error", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-sn",
        ...(copyV ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-force_key_frames", `expr:gte(t,n_forced*${HLS_TIME})`]),
        ...(copyA ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k", "-ac", "2"]),
        "-f", "hls", "-hls_time", String(HLS_TIME), "-hls_playlist_type", "vod", "-hls_segment_type", "mpegts",
        "-hls_segment_filename", path.join(tmp, "seg_%05d.ts"), path.join(tmp, "index.m3u8"),
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    })().finally(() => hlsJobs.delete(key)));
  }
  await hlsJobs.get(key);
  return m3u8;
}

/* ───────────── 数据映射 ───────────── */

const ok = (data) => ({ status: 1, data });
const fail = (msg) => ({ status: 0, msg });
const AUTHOR = { id: 1, name: "NAS", avatar: null, followers: 0 };
const USER = { id: 1, username: "nas", nickname: "NAS", avatar: "", avatar_color: "#0b6e99", counts: {} };
const durText = (s) => (s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");

function card(v, base) {
  return {
    id: v.id, title: v.title, cover: `${base}/media/cover/${v.id}.jpg`, description: v.description, tags: v.tags,
    score: v.score, episode_count: v.files.length, total_episodes: v.files.length, hot: 0, like_count: 0,
    collect_count: 0, comment_count: 0, is_finished: true, is_original: 0,
    created_at: new Date(v.mtime).toISOString(), new_at: Math.floor(v.mtime / 1000), author: AUTHOR,
  };
}
function paged(items, q, base) {
  const size = Math.min(Math.max(Number(q.get("size")) || 20, 1), 100);
  const page = Math.max(Number(q.get("page")) || 1, 1);
  return { items: items.slice((page - 1) * size, page * size).map((v) => card(v, base)), pagination: { page, size, total: items.length, pages: Math.ceil(items.length / size) } };
}
const emptyPage = (q) => ({ items: [], pagination: { page: Number(q.get("page")) || 1, size: Number(q.get("size")) || 20, total: 0, pages: 0 } });

async function detail(v, base) {
  // 集数多时不逐个 ffprobe（网络盘上很慢）；时长在播放接口里再给
  const probeAll = v.files.length <= 20;
  const eps = [];
  for (let i = 0; i < v.files.length; i++) {
    const info = probeAll ? await probe(v.files[i]).catch(() => ({ duration: 0 })) : probeCache.get(v.files[i]) || { duration: 0 };
    const name = path.basename(v.files[i], path.extname(v.files[i]));
    eps.push({ ep_num: i + 1, title: v.files.length === 1 ? v.title : name, duration: info.duration, status: 1 });
  }
  return { video: { ...card(v, base), episodes: eps, counts: { collect: 0, comment: 0, hot: 0, like: 0 }, author: AUTHOR, interaction: { collected: false, liked: false }, duration: eps.reduce((s, e) => s + e.duration, 0) } };
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
  if ((m = p.match(/^\/api\/videos\/category\/(.+)$/))) { const c = decodeURIComponent(m[1]); return ok(paged(all.filter((v) => v.tags.includes(c)), q, base)); }
  if ((m = p.match(/^\/api\/videos\/tag\/(.+)$/))) { const t = decodeURIComponent(m[1]); return ok(paged(all.filter((v) => v.tags.includes(t)), q, base)); }
  if (p === "/api/videos/following") return ok(emptyPage(q));
  if ((m = p.match(/^\/api\/videos\/user\/\d+$/))) return ok(paged(all, q, base));
  if ((m = p.match(/^\/api\/videos\/(\d+)\/related$/))) return ok({ items: all.filter((v) => v.id !== +m[1]).slice(0, 12).map((v) => card(v, base)) });
  if ((m = p.match(/^\/api\/videos\/(\d+)\/comments$/))) return ok({ ep: Number(q.get("ep")) || 1, items: [], pagination: { page: 1, size: 20, total: 0, pages: 0 } });
  if ((m = p.match(/^\/api\/videos\/(\d+)\/(like|collect)$/))) return ok({ liked: method !== "DELETE", collected: method !== "DELETE" });

  // 播放：主接口 episodes/{ep}/playback；旧接口 /play?ep= 作为回退
  if ((m = p.match(/^\/api\/videos\/(\d+)\/episodes\/(\d+)\/playback$/)) || (m = p.match(/^\/api\/videos\/(\d+)\/play$/))) {
    const v = LIBRARY.byId.get(+m[1]);
    const ep = m[2] ? +m[2] : Number(q.get("ep")) || 1;
    if (!v || ep < 1 || ep > v.files.length) return fail("影片不存在");
    await ensureHls(v, ep);
    const info = await probe(v.files[ep - 1]).catch(() => ({ duration: 0 }));
    const url = `${base}/media/hls/${v.id}/${ep}/index.m3u8`;
    return ok({ id: v.id, ep_num: ep, duration: info.duration, title: v.title, video_url: url, streams: { main: url } });
  }
  if ((m = p.match(/^\/api\/videos\/(\d+)$/))) { const v = LIBRARY.byId.get(+m[1]); return v ? ok(await detail(v, base)) : fail("影片不存在"); }

  if (p === "/api/search") {
    if (q.get("type") === "post") return ok(emptyPage(q));
    const kw = (q.get("q") || "").toLowerCase();
    return ok({ ...paged(all.filter((v) => v.title.toLowerCase().includes(kw)), q, base), keyword: q.get("q") || "" });
  }
  if (p === "/api/search/hot") return ok({ items: [] });
  if ((m = p.match(/^\/api\/ranks\/(\w+)$/)))
    return ok({ type: m[1], items: all.slice(0, 20).map((v, i) => ({ rank: i + 1, video_id: v.id, title: v.title, cover: `${base}/media/cover/${v.id}.jpg`, tags: v.tags, score: v.score, episode_count: v.files.length, is_finished: true, metric_label: "", metric_value: 0, metrics: {} })) });
  if (p === "/api/tags") {
    const tags = [...new Set(all.flatMap((v) => v.tags))];
    return ok({ categories: [{ id: 1, code: "type", name: "分类", sort: 0, tags: tags.map((t, i) => ({ id: i + 1, name: t, slug: t })) }] });
  }
  if (p === "/api/topics") return ok({ items: [] });
  if (p.startsWith("/api/posts") || p === "/api/site/categories/post") return ok(p === "/api/site/categories/post" ? { items: [] } : emptyPage(q));
  if ((m = p.match(/^\/api\/users\/\d+(\/stats)?$/))) return ok(m[1] ? {} : USER);
  if (p.match(/^\/api\/users\/\d+\/follow$/)) return ok({ following: method !== "DELETE" });
  return fail(`未实现的接口: ${p}`);
}

/* ───────────── HTTP ───────────── */

function sendFile(req, res, file, ctype) {
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
    "Content-Type": ctype, "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
    ...(code === 206 && { "Content-Range": `bytes ${start}-${end}/${st.size}` }),
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
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
      console.log(`[api] ${env.method} ${env.path} -> ${out.status} ${Date.now() - t0}ms`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(out));
      return;
    }
    let m;
    if ((m = url.pathname.match(/^\/media\/cover\/(\d+)\.jpg$/))) {
      const v = LIBRARY.byId.get(+m[1]);
      if (!v) return void res.writeHead(404).end();
      const f = await coverPath(v);
      const ext = path.extname(f).toLowerCase();
      return sendFile(req, res, f, ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg");
    }
    if ((m = url.pathname.match(/^\/media\/hls\/(\d+)\/(\d+)\/(index\.m3u8|seg_\d+\.ts)$/))) {
      const file = path.join(CACHE_DIR, "hls", m[1], m[2], m[3]);
      return sendFile(req, res, file, m[3].endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
    }
    if (url.pathname === "/" || url.pathname === "/health") return void res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(`HGhubX NAS backend: ${LIBRARY.list.length} videos\n`);
    res.writeHead(404).end("not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message || e));
  }
});

scan();
fs.watch(MEDIA_DIR, { persistent: false }, () => { clearTimeout(scan.t); scan.t = setTimeout(scan, 2000); });
setInterval(scan, 10 * 60 * 1000).unref();
server.listen(PORT, "0.0.0.0", () => console.log(`[http] 监听 0.0.0.0:${PORT}，客户端接入地址填 http://<本机IP>:${PORT}`));
