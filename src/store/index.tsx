import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform } from "../api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity, setSiteBase } from "../html";
import { appDataKey } from "../branding";
import type { BootInfo, GateState, NasStatus, User } from "../types";
import type { SubMode } from "../subtitles";
import { libraryApi, LIBRARY_POLL_MS } from "../library";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number }
  | { kind: "topics"; key: string }
  | { kind: "topic"; key: string; slug: string; name: string }
  | { kind: "tags"; key: string }
  | { kind: "tag"; key: string; tag: string; name: string }
  | { kind: "following"; key: string }
  | { kind: "user"; key: string; id: number; name?: string };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "posts" }
  | { kind: "post"; id: number }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; name: string }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "following" }
  | { kind: "user"; id: number; name?: string };

export type Toast = {
  id: number;
  msg: string;
  icon?: "ok" | "heart" | "star" | "info";
  };

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** 上下划切集：多集短剧上下滑就换集，而不是换下一部 */
  swipeEp: boolean;
  /** 优先高清：有 HEVC 就用 HEVC，播不了自动回退标准 */
  preferHevc: boolean;
  /** 字幕显示：关 / 中文 / 原文 / 双语（有字幕的视频才生效） */
  subMode: SubMode;
};

const LS = appDataKey("default");
const LEGACY_LS = "hghubx_app_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], swipeEp: true, preferHevc: false, subMode: "both",
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS) ?? localStorage.getItem(LEGACY_LS);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    /* 1.2.9 起上下划默认就是切集。老配置里 swipeEp 存的 false 是当年的默认值，
       不是用户主动关的，所以这里做一次性迁移；用户之后自己关掉不会再被改回来。 */
    let swipeEp = p.swipeEp !== false;
    try {
      if (localStorage.getItem("hghubx_swipe_ep_v2") !== "1") {
        swipeEp = true;
        localStorage.setItem("hghubx_swipe_ep_v2", "1");
      }
    } catch { /* ignore */ }
    return { ...p, swipeEp, muteOnStartup, muted: muteOnStartup || p.muted === true, history: normalizeHistory(p.history) };
  } catch {
    return DEFAULTS;
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem("hghubx_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 移动端「净屏」：只留画面，UI 全隐 */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  swipeEp: boolean; setSwipeEp: (on: boolean) => void;
  subMode: SubMode; setSubMode: (m: SubMode) => void;
  preferHevc: boolean; setPreferHevc: (on: boolean) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
  /** 接入地址（门牌）切换计数：变了就让列表页重挂载，重新拉一遍数据 */
  lineEpoch: number;
  /** 片库变化计数：NAS 片库的视频有增删（定期检查 / 手动刷新发现）就加一，列表页据此刷新 */
  libraryEpoch: number;
  /** 立即让后端重扫片库并刷新列表；不支持的数据源返回 null */
  refreshLibrary: () => Promise<{ count: number; changed: boolean } | null>;
  /** 门牌：未激活时只显示 SourceGate，不拉业务数据 */
  gate: GateState; gateReady: boolean; gateBusy: boolean; gateError: string;
  activateGate: (address: string) => Promise<void>;
  resetGate: () => Promise<void>;
  /** 内置 NAS 服务（随应用启动的本机后端）：状态由 Rust 事件推送 */
  nas: NasStatus; nasLoaded: boolean;
  /** 启用 / 停用 / 改配置；启用后接入地址自动指向本机服务 */
  configureNas: (enabled: boolean, mediaDir: string, port?: number) => Promise<void>;
  restartNas: () => Promise<void>;
};

const NAS_OFF: NasStatus = { enabled: false, state: "off", message: "", port: 17680, media_dir: "", base: "", videos: null, categories: null, log: [] };

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lineEpoch, setLineEpoch] = useState(0);
  const [libraryEpoch, setLibraryEpoch] = useState(0);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const [gate, setGate] = useState<GateState>({ base: "", adapter: "edge_v1", activated: false });
  const [gateReady, setGateReady] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState("");
  const [nas, setNas] = useState<NasStatus>(NAS_OFF);
  const [nasLoaded, setNasLoaded] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghubx_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  const applyBoot = useCallback((r: BootInfo) => {
    if (r.user && r.user.id) setUser(r.user);
    if (r.gate) setGate(r.gate);
    // 兼容旧壳（无 gate_state / boot 不带 gate）：有 base 即视为已激活，避免老用户被门牌页挡住。
    else if (r.base) setGate({ base: r.base, adapter: "edge_v1", activated: true });
    setSiteBase(r.base || r.gate?.base || "");
    if (typeof r.strict_security === "boolean") {
      setStrictSecurityState(r.strict_security);
      setHtmlStrictSecurity(r.strict_security);
      setStrictSecurityReady(true);
    }
    setCliRelaxed(!!r.cli_relaxed);
  }, []);

  /* 启动只读门牌；没有门牌时 SourceGate 不触发任何业务数据请求。 */
  useEffect(() => {
    let alive = true;
    api.gateState()
      .then((g) => {
        if (!alive) return;
        setGate(g);
        setGateReady(true);
        if (g.activated) api.boot().then((r) => { if (alive) applyBoot(r); }).catch(() => {});
      })
      .catch(() => {
        if (!alive) return;
        setGateReady(true);
        // 兼容旧壳：gate_state 不存在时仍尝试 boot，避免直接卡死
        api.boot().then((r) => { if (alive) applyBoot(r); }).catch(() => {});
      });
    return () => { alive = false; };
  }, [applyBoot]);

  const activateGate = useCallback(async (address: string) => {
    const raw = address.trim();
    if (!raw) { setGateError("请输入接入地址"); throw new Error("请输入接入地址"); }
    setGateBusy(true);
    setGateError("");
    try {
      const next = await api.gateOpen(raw);
      setGate(next);
      setSiteBase(next.base);
      setUser(null);
      setStack([]);
      setTabRaw("home");
      setLoginOpen(false);
      setLineEpoch((n) => n + 1);
      api.boot().then(applyBoot).catch(() => {});
    } catch (e) {
      const msg = (e as Error).message || "接入失败";
      setGateError(msg);
      throw e;
    } finally {
      setGateBusy(false);
    }
  }, [applyBoot]);

  const resetGate = useCallback(async () => {
    const next = await api.gateReset();
    setGate(next);
    setUser(null);
    setStack([]);
    setTabRaw("home");
    setSiteBase("");
  }, []);

  /* 内置 NAS 服务状态：先读一次快照，再订阅 Rust 推送；启动中每秒兜底拉取，防止事件在订阅前就发完 */
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    api.nasStatus().then((r) => { if (alive) setNas(r); }).catch(() => {}).finally(() => { if (alive) setNasLoaded(true); });
    api.onNasStatus((r) => { if (alive) setNas(r); }).then((fn) => { if (alive) unlisten = fn; else fn(); }).catch(() => {});
    return () => { alive = false; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (nas.state !== "starting") return;
    const t = window.setInterval(() => { api.nasStatus().then(setNas).catch(() => {}); }, 1000);
    return () => window.clearInterval(t);
  }, [nas.state]);
  /* 从启动中变为就绪：弹一条提示（启动页消失本身也是反馈，这条补上规模信息） */
  const prevNasState = useRef(nas.state);
  useEffect(() => {
    if (prevNasState.current === "starting" && nas.state === "ready") {
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-2), { id, msg: `NAS 服务已就绪 · ${nas.videos ?? 0} 个视频`, icon: "ok" }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
    }
    prevNasState.current = nas.state;
  }, [nas.state, nas.videos]);

  const configureNas = useCallback(async (enabled: boolean, mediaDir: string, port?: number) => {
    const wasLocal = gate.base === nas.base;
    try {
      const next = await api.nasConfigure(enabled, mediaDir, port);
      setNas(next);
      if (enabled) {
        // 接入地址指向本机服务（重置会话与列表）；启动页会挡住业务请求直到服务就绪
        await activateGate(next.base);
      } else if (wasLocal) {
        await resetGate(); // 服务已停用，原来的本机地址不再有效
      }
    } catch (e) {
      throw new Error(typeof e === "string" ? e : (e as Error).message || "保存失败");
    }
  }, [gate.base, nas.base, activateGate, resetGate]);

  const restartNas = useCallback(async () => {
    setNas(await api.nasRestart());
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  /* 定期检查片库有没有变化：后端每 5 分钟重扫一次，前端每分钟（以及窗口回到前台时）问一次版本号，
     变了就弹提示并让列表页刷新。只对内置 NAS 这类有 /library 接口的数据源生效，取不到就停止轮询。 */
  const libVersion = useRef("");
  const checkLibrary = useCallback(async (base: string, refresh = false) => {
    const st = await (refresh ? libraryApi.refresh(base) : libraryApi.status(base));
    const changed = !!libVersion.current && !!st.version && st.version !== libVersion.current;
    const delta = st.count - (Number(libCount.current) || st.count);
    libCount.current = st.count;
    libVersion.current = st.version;
    if (changed) {
      setLibraryEpoch((e) => e + 1);
      if (!refresh) toast(`片库已更新 · 共 ${st.count} 个视频${delta ? `（${delta > 0 ? "+" : "−"}${Math.abs(delta)}）` : ""}`, "ok");
    }
    return { count: st.count, changed };
  }, [toast]);
  const libCount = useRef(0);
  useEffect(() => {
    libVersion.current = ""; libCount.current = 0;
    if (!gate.activated || !gate.base) return;
    const base = gate.base;
    let alive = true, supported = true, timer = 0;
    const tick = () => {
      if (!alive || !supported || document.hidden) return;
      checkLibrary(base).catch((e) => { if (/HTTP 404/.test((e as Error).message || "")) supported = false; /* 其它错误（暂时不通）下次再试 */ });
    };
    tick();
    timer = window.setInterval(tick, LIBRARY_POLL_MS);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [gate.activated, gate.base, checkLibrary]);
  const refreshLibrary = useCallback(async () => {
    if (!gate.activated || !gate.base) return null;
    try { return await checkLibrary(gate.base, true); } catch { return null; }
  }, [gate.activated, gate.base, checkLibrary]);



  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); }, []);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: epChanged ? 0 : (t ?? prev?.t ?? 0),
        dur: dur ?? prev?.dur ?? 0,
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setUser(null);
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
    // 进出全屏/净屏时把「净屏」收掉，避免退出后 UI 还藏着
    setCleanState(false);
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setSwipeEp = useCallback((on: boolean) => {
    setP((s) => ({ ...s, swipeEp: on }));
  }, []);
  const setSubMode = useCallback((m: SubMode) => {
    setP((s) => ({ ...s, subMode: m }));
  }, []);
  const setPreferHevc = useCallback((on: boolean) => {
    setP((s) => ({ ...s, preferHevc: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, setTheme: setThemeState,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    swipeEp: p.swipeEp, setSwipeEp,
    subMode: p.subMode, setSubMode,
    preferHevc: p.preferHevc, setPreferHevc,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, lineEpoch, libraryEpoch, refreshLibrary,
    gate, gateReady, gateBusy, gateError, activateGate, resetGate,
    nas, nasLoaded, configureNas, restartNas,
  }), [theme, tab, setTab, stack, push, pop, user, loginOpen, logout,
    p, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory,
    setMuted, setMuteOnStartup, setSwipeEp, setSubMode, setPreferHevc, setVolume, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, lineEpoch, libraryEpoch, refreshLibrary, theater, setTheater, fs, setFs, clean, setClean,
    gate, gateReady, gateBusy, gateError, activateGate, resetGate, nas, nasLoaded, configureNas, restartNas]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
