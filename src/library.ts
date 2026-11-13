import { directMedia } from "./api";

/** 内置 NAS 后端的片库接口（GET + JSON，经本地媒体代理访问）。其它数据源没有这些接口：取不到就当不支持。 */
export type LibStatus = { version: string; count: number; categories: number; scannedAt: number; scanning: boolean };

async function getJson<T>(base: string, path: string): Promise<T> {
  // 带时间戳：本地代理和 WebView 都会按 URL 缓存小响应
  const url = `${base.replace(/\/+$/, "")}${path}?_=${Date.now()}`;
  const res = await fetch(directMedia(url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const libraryApi = {
  status: (base: string) => getJson<LibStatus>(base, "/library/status"),
  /** 立即重扫一遍（扫描完才返回） */
  refresh: (base: string) => getJson<LibStatus>(base, "/library/refresh"),
  ids: (base: string) => getJson<{ version: string; ids: number[] }>(base, "/library/ids"),
};

/** 轮询间隔：后端每 5 分钟重扫一次，这里每分钟问一次版本号（很轻） */
export const LIBRARY_POLL_MS = 60_000;
