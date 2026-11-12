import { directMedia } from "./api";

/** 内置 NAS 后端的字幕接口（本地语音识别 + 翻译）。全是 GET + JSON，经本地媒体代理访问。
 *  其它数据源没有这些接口：capabilities 取不到就当作“不支持”，界面里不显示字幕入口。 */

export type SubState = "idle" | "queued" | "running" | "error" | "done";
export type SubStatus = {
  state: SubState;
  stage?: "queued" | "extract" | "transcribe" | "translate";
  progress?: number;
  message?: string;
  language?: string;
  translated?: boolean;
  version?: string;
  count?: number;
  queued?: number;
};
export type SubCaps = { asr: boolean; vad: boolean; translate: boolean; missing: string[]; note: string };
/** s / e 秒；t 原文；z 中文翻译（没翻译时没有） */
export type Cue = { s: number; e: number; t: string; z?: string };
export type CueDoc = { version: string; language: string; translated: boolean; note?: string; cues: Cue[] };
export type SubMode = "off" | "zh" | "orig" | "both";

export const LANGS: { code: string; name: string }[] = [
  { code: "auto", name: "自动识别" }, { code: "ja", name: "日语" }, { code: "es", name: "西班牙语" },
  { code: "en", name: "英语" }, { code: "ko", name: "韩语" }, { code: "fr", name: "法语" },
  { code: "de", name: "德语" }, { code: "ru", name: "俄语" }, { code: "pt", name: "葡萄牙语" }, { code: "it", name: "意大利语" },
];
export const langName = (code?: string) => LANGS.find((l) => l.code === code)?.name || code || "";

async function getJson<T>(base: string, path: string): Promise<T> {
  // 带时间戳：本地代理和 WebView 都会按 URL 缓存小响应，状态类接口必须每次不同
  const url = `${base.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;
  const res = await fetch(directMedia(url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const key = (id: number, ep: number) => `/sub/${id}/${ep}`;
export const subApi = {
  caps: (base: string) => getJson<SubCaps>(base, "/sub/capabilities"),
  status: (base: string, id: number, ep: number) => getJson<SubStatus>(base, `${key(id, ep)}/status`),
  start: (base: string, id: number, ep: number, lang: string, force: boolean) =>
    getJson<SubStatus>(base, `${key(id, ep)}/start?lang=${encodeURIComponent(lang)}${force ? "&force=1" : ""}`),
  cancel: (base: string, id: number, ep: number) => getJson<SubStatus>(base, `${key(id, ep)}/cancel`),
  remove: (base: string, id: number, ep: number) => getJson<SubStatus>(base, `${key(id, ep)}/remove`),
  /** 字幕内容随版本号变化，URL 带 version 才不会读到旧缓存 */
  cues: (base: string, id: number, ep: number, version: string) =>
    getJson<CueDoc>(base, `${key(id, ep)}/cues.json?v=${encodeURIComponent(version)}`),
};

/** 二分查找：时间 t 落在哪条字幕里（没有返回 -1）。cues 按开始时间升序。 */
export function cueAt(cues: readonly Cue[], t: number): number {
  let lo = 0, hi = cues.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].s <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // 往前多看几条：相邻字幕时间可能重叠，最后开始的那条未必是仍在显示的
  for (let i = found; i >= 0 && i > found - 3; i--) if (t >= cues[i].s && t <= cues[i].e + 0.15) return i;
  return -1;
}

/** 当前模式下这条字幕该显示什么：主行（大）与副行（小，仅双语） */
export function cueLines(cue: Cue, mode: SubMode, translated: boolean): { main: string; sub?: string } {
  if (mode === "off") return { main: "" };
  if (!translated || !cue.z) return { main: cue.t }; // 没翻译就只能显示原文
  if (mode === "orig") return { main: cue.t };
  if (mode === "zh") return { main: cue.z };
  return { main: cue.z, sub: cue.t };
}

const ORDER: SubMode[] = ["off", "both", "zh", "orig"];
/** 快捷键 V：按 关 → 双语 → 中文 → 原文 循环；没有翻译时跳过中文 / 双语 */
export function nextSubMode(mode: SubMode, translated: boolean): SubMode {
  const modes = translated ? ORDER : (["off", "orig"] as SubMode[]);
  const i = modes.indexOf(mode);
  return modes[(i + 1) % modes.length] ?? "off";
}
