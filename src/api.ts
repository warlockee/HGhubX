import { tracePlayback } from "./player/diagnostics";
import { dataCall, type DataCommand } from "./data/client";
import { commands } from "./data/commands";
import {
  checkUpdate, clearCache, gateOpen, gateReset, gateState, logLine, netDiag, openUrl, securitySet,
  setOrientation,
} from "./platform";
import type {
  BootInfo, CommentPage, Detail, HotWord, Paged, PlayInfo, Post, PostCategory, RankItem, TagGroup, TopicCard, TopicDetail, User, UserProfile, VideoCard,
} from "./types";

export { logLine };

/* ── 运行环境 ───────────────────────────────────────────── */

/** 应用版本（构建时由 vite.config.ts 从 package.json 注入） */
export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
/** iPhone 的 UA 也带「like Mac OS X」，必须先于 macOS 判断；iPadOS 默认伪装成 Mac，用触点数区分。 */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  // iPadOS 13+ 默认把自己报成 MacIntel，只能靠触点数认
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
/** Linux 桌面：webkit2gtk 的 UA 是「X11; Linux x86_64」。必须排在 Windows 之前判断，
 *  否则会被当成 Windows；而 Android 的 UA 里同样带「Linux」，所以必须先排除安卓。 */
export const isLinux = !isAndroid && !isIos && !isMacos && /Linux|X11/i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" | "linux" =
  isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : isLinux ? "linux" : "windows";
/** WebView 内核版本：能不能走 MSE、能解哪些封装，是「无法播放」的首要判据。
 *  安卓取 Chrome/xxx（System WebView），Linux/macOS 取 WebKit 的 Version/xxx。 */
export const webviewVersion =
  /Chrome\/([\d.]+)/.exec(ua)?.[1] || /Version\/([\d.]+)/.exec(ua)?.[1] || "?";
/** 移动端（安卓 / iOS）共用触屏界面 */
export const isMobile = isAndroid || isIos;

/** 媒体基址随平台不同（Rust 侧对应 `media::LOCAL_ORIGIN`，两边必须一致）：
 *  Windows / Android → `http://<scheme>.localhost`（自定义协议，WebView 自己加载）
 *  macOS / iOS → `hg://localhost`（WebKit 的 scheme handler）
 *  Linux → `http://127.0.0.1:17650`：WebKitGTK 的 <video> 由 GStreamer 播放，
 *          它拿不到自定义 scheme，所以由 Rust 侧在 loopback 上起 HTTP 代理
 *          （`src-tauri/src/linux_http.rs`，端口必须与此一致）。 */
export const LOCAL =
  isMacos || isIos ? "hg://localhost" : isLinux ? "http://127.0.0.1:17650" : "http://hg.localhost";

/** src 是否已是本地协议地址（避免在详情页把代理地址再包一层） */
export const isLocalMedia = (src: string) => src.startsWith(`${LOCAL}/`);

/** 封面：经本地协议解密（站点封面是 AES 密文）。 */
export const cover = (url?: string, _w = 480) =>
  url ? `${LOCAL}/img?u=${encodeURIComponent(url)}` : "";

/** 播放列表：经本地协议改写分片地址，规避 CORS 与防盗链。 */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

/* ── 调用封装 ───────────────────────────────────────────── */

/** 网络类失败的样子：没有 HTTP 状态码，纯链路层（DNS / 连接 / 超时 / TLS） */
const NET_FAIL = /dns|timed? ?out|timeout|connection|refused|reset|unreachable|broken pipe|tls|ssl|handshake|证书|网络|连接/i;
/** 只读命令：链路抖动时可以安全重试一次；写操作绝不重试（避免重复提交） */
const READ_ONLY = new Set([
  "api_me", "api_feed", "api_category", "api_rank", "api_search",
  "api_posts", "api_post", "api_post_comments", "api_video", "api_play", "api_comments",
  "api_topics", "api_topic", "api_tags", "api_tag_videos", "api_search_hot",
  "api_post_playback", "api_post_categories", "api_post_category", "api_related", "api_following", "api_user", "api_user_stats", "api_user_videos",
]);
/** 给自动选线用的观察点。api.ts 不反向依赖 autoLine，避免循环 import。 */
export type NetObserver = (r: { ok: boolean; cmd: string; msg?: string; networkish?: boolean }) => void;
let netObserver: NetObserver | null = null;
export const setNetObserver = (fn: NetObserver | null) => { netObserver = fn; };
const notifyNet = (r: Parameters<NetObserver>[0]) => {
  try { netObserver?.(r); } catch { /* 观察者不能影响请求本身 */ }
};
const failMessage = (msg: string, status?: string) =>
  status
    ? `服务器请求失败（HTTP ${status}），请稍后重试或在设置中切换线路`
    : msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;

/** 统一业务调用：只走 DomainCommand → data_call；`label` 仅用于日志与重试白名单。 */
async function call<T>(cmd: string, command: DataCommand): Promise<T> {
  const once = () => dataCall<T>(command);
  try {
    const r = await once();
    notifyNet({ ok: true, cmd });
    return r;
  } catch (e) {
    const msg = typeof e === "string" ? e : "请求失败，请检查网络";
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    const networkish = !status && NET_FAIL.test(msg);
    // 落盘完整错误链（dns error / connection refused / 证书错误…），toast 只显示截断版
    logLine(`[api] ${cmd} → ${msg}`);
    tracePlayback("api.fail", { cmd, err: msg, status: status ?? null, networkish });
    notifyNet({ ok: false, cmd, msg, networkish });
    // 线路可能正被自动切走：给切换留一点时间，只读请求重试一次，用户就不用看见这条错误
    if (networkish && READ_ONLY.has(cmd)) {
      logLine(`[api] ${cmd} 链路异常，1.2s 后重试一次`);
      tracePlayback("api.retry", { cmd, err: msg });
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await once();
        logLine(`[api] ${cmd} 重试成功`);
        tracePlayback("api.retry_ok", { cmd });
        notifyNet({ ok: true, cmd });
        return r;
      } catch (e2) {
        const again = typeof e2 === "string" ? e2 : msg;
        const againStatus = /^HTTP (\d{3})\b/.exec(again)?.[1];
        logLine(`[api] ${cmd} 重试仍失败 → ${again}`);
        tracePlayback("api.retry_failed", { cmd, err: again, status: againStatus ?? null });
        throw new Error(failMessage(again, againStatus));
      }
    }
    throw new Error(failMessage(msg, status));
  }
}

/* ── 接口 ───────────────────────────────────────────────── */

export const api = {
  boot: () => call<BootInfo>("app_boot", commands.boot()),
  gateState,
  gateOpen,
  gateReset,
  securitySet,
  login: (username: string, password: string) =>
    call<{ user: User }>("api_login", commands.login(username, password)),
  register: (username: string, password: string, email = "") =>
    call<{ user: User }>("api_register", commands.register(username, password, email)),
  logout: () => call<{ ok: boolean }>("api_logout", commands.logout()),
  me: () => call<User>("api_me", commands.me()),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", commands.feed(page, size)),
  topics: () => call<{ items: TopicCard[] }>("api_topics", commands.topics()),
  topic: (slug: string) => call<TopicDetail>("api_topic", commands.topic(slug)),
  tags: () => call<{ categories: TagGroup[] }>("api_tags", commands.tags()),
  tagVideos: (tag: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>("api_tag_videos", commands.tagVideos(tag, page, size)),
  category: (cate: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>("api_category", commands.category(cate, page, size)),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", commands.rank(kind)),
  /** 全站搜索。`kind` 省略时后端只搜短剧；吃瓜帖要显式传 "post"（issue #34）。 */
  search: (q: string, page = 1, size = 20, kind?: "video" | "post") =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", commands.search(q, page, size, kind ?? ""),
    ),
  /** 只搜吃瓜帖：返回结构是 Post 而不是 VideoCard。 */
  searchPosts: (q: string, page = 1, size = 20) =>
    call<{ items: Post[]; pagination: Paged<Post>["pagination"]; keyword: string }>(
      "api_search", commands.search(q, page, size, "post"),
    ),
  searchHot: () => call<{ items: HotWord[] }>("api_search_hot", commands.searchHot()),
  posts: (page = 1, size = 20) => call<Paged<Post>>("api_posts", commands.posts(page, size)),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", commands.post(id)),
  /** 吃瓜帖视频：详情里 video_url 恒为空，地址由 playback 接口下发（可能多段）。 */
  postPlayback: (id: number) => call<{ mode?: number; videos?: { index: number; url: string }[] }>("api_post_playback", commands.postPlayback(id)),

  video: (id: number) => call<Detail>("api_video", commands.video(id)),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", commands.play(id, ep)),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", commands.comments(id, ep, page, size)),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", commands.commentSend(id, ep, text, replyId)),

  clearCache,
  netDiag,
  setOrientation,
  postLike: (id: number, on: boolean) => call<unknown>("api_post_like", commands.postLike(id, on)),
  postCollect: (id: number, on: boolean) => call<unknown>("api_post_collect", commands.postCollect(id, on)),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", commands.postComments(id, page, size)),
  postCategories: () => call<{ items: PostCategory[] }>("api_post_categories", commands.postCategories()),
  postCategory: (route: string, page = 1, size = 20) =>
    call<Paged<Post>>("api_post_category", commands.postCategory(route, page, size)),
  related: (id: number) => call<{ items: VideoCard[] }>("api_related", commands.related(id)),
  following: (page = 1, size = 20) => call<Paged<VideoCard>>("api_following", commands.following(page, size)),
  user: (id: number) => call<UserProfile>("api_user", commands.user(id)),
  userStats: (id: number) => call<{ user_id: number; like_count: number; following: number; followers: number; video_count: number; post_count: number }>("api_user_stats", commands.userStats(id)),
  userVideos: (id: number, page = 1, size = 20) => call<Paged<VideoCard>>("api_user_videos", commands.userVideos(id, page, size)),
  like: (id: number, ep: number, on: boolean) => call<unknown>("api_like", commands.like(id, ep, on)),
  collect: (id: number, on: boolean) => call<unknown>("api_collect", commands.collect(id, on)),
  follow: (uid: number, on: boolean) => call<unknown>("api_follow", commands.follow(uid, on)),

  /* 更新检查：对比 GitHub Release 的 tag */
  checkUpdate,
  openUrl,
};

/** `https://a.b/c` → `a.b`（线路展示用） */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/* ── 自检：验证 webview → 本地协议 → 上游 的取流链路 ───────── */
export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        // A/B：用 JS 重新编码同一条上游地址
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

/** 非 m3u8 媒体（mp4 等）走 /seg 原样透传 */
export function directMedia(url: string): string {
  return `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

/** 按扩展名选择代理方式：m3u8 → 播放列表改写；其它 → 原样透传 */
export function mediaUrl(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? playlist(url) : directMedia(url);
}

/** 预热直连 mp4：开头几块 + 文件尾（mp4 的索引 moov 常在末尾）。
 *  切到这个视频时数据已经在本地块缓存里，首帧更快；失败无所谓。m3u8 由后端和 hls.js 自己处理。 */
export function warmMedia(url: string): void {
  if (!url || /\.m3u8(\?|$)/i.test(url)) return;
  const u = directMedia(url);
  for (const range of ["bytes=0-", "bytes=-1048576"]) {
    fetch(u, { headers: { Range: range } }).then((r) => r.arrayBuffer()).catch(() => { /* 预热失败不影响播放 */ });
  }
}
