import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { isMobile, selfTest } from "./api";
import { exitApp, isWindowFullscreen, logLine, onWindowResized, setTextInteraction, setWindowFullscreen } from "./platform";
import { addPluginListener } from "@tauri-apps/api/core";
import { runBack } from "./back";
import Home from "./pages/Home";
import Search, { RankPage } from "./pages/Search";
import Category, { ChannelPage } from "./pages/Category";
import Profile from "./pages/Profile";
import SettingsPage from "./pages/Settings";
import Feed from "./pages/Feed";
import { PostsPage, PostDetail } from "./pages/Posts";
import { TopicsPage, TopicPage, TagsPage, TagPage } from "./pages/Discover";
import { FollowingPage, UserPage } from "./pages/User";
import LoginModal from "./components/LoginModal";
import SourceGate from "./components/SourceGate";
import NasSplash from "./components/NasSplash";
import { ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar } from "./components/DesktopChrome";
import { nextRailMode, parseRailMode, toggleHidden, type RailMode } from "./railMode";
import ResizeHandles from "./components/ResizeHandles";
import { tracePlayback } from "./player/diagnostics";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF, Logo } from "./icons";

/* ============ 底部标签栏（移动端）—— iOS 26 液态玻璃悬浮胶囊 ============ */
/* 设计对齐 liuran001/WeChat-LiquidGlass（iOS 26 风格）：
   - 不贴边的悬浮胶囊玻璃条，内容透出真实折射感（backdrop blur + 高光内描边）
   - 选中项是一枚「液滴」玻璃胶囊，用弹簧物理滑动跟随（无 JS 逐帧驱动，
     用 CSS transition + cubic-bezier 近似 WeChat-LiquidGlass 的 DampedDragAnimation）
   - 按压时液滴放大（对齐其 press scale 1.1x），图标带充色 */
function TabBar() {
  const { tab, setTab, theme, platform } = useStore();
  const android = platform === "android";
  const items: { k: Tab; label: string; On: (p: { size?: number; className?: string; style?: React.CSSProperties; strokeWidth?: number }) => React.JSX.Element; Off: (p: { size?: number; className?: string; style?: React.CSSProperties; strokeWidth?: number }) => React.JSX.Element }[] = [
    { k: "home", label: "首页", On: IHomeF, Off: IHome },
    { k: "search", label: "搜索", On: ISearch, Off: ISearch },
    { k: "category", label: "分类", On: IGridF, Off: IGrid },
    { k: "profile", label: "我的", On: IUserF, Off: IUser },
  ];
  const idx = items.findIndex((i) => i.k === tab);
  const overVideo = tab === "home";
  const light = !overVideo && theme === "light";
  /* 液滴中心对齐每个等分槽位的中心，定位不受固定胶囊宽度影响。 */
  const dropLeft = `${12.5 + idx * 25}%`;
  return (
    <nav className="hg-tabbar absolute inset-x-0 bottom-0 z-30 flex justify-center"
      style={{ paddingBottom: android ? "var(--sab, 0px)" : "calc(var(--sab, 0px) * 0.55)" }} aria-label="主导航">
      <div className="hg-glass relative" style={{
        width: "min(92vw, 420px)",
        height: 56,
        borderRadius: 28,
        background: light ? "rgba(250, 250, 250, .62)" : "rgba(22, 22, 24, .55)",
        boxShadow: light
          ? "0 8px 32px rgba(0,0,0,.12), 0 1px 0 rgba(255,255,255,.85) inset, 0 0 0 .5px rgba(0,0,0,.06)"
          : "0 8px 32px rgba(0,0,0,.38), 0 1px 0 rgba(255,255,255,.16) inset, 0 0 0 .5px rgba(255,255,255,.10)",
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
      }}>
        {/* 液滴：跟随选中项的玻璃胶囊 */}
        <div className="hg-drop absolute top-[4px] bottom-[4px] w-[56px]" style={{
          left: dropLeft,
          transform: "translateX(-50%)",
          borderRadius: 24,
          transition: "left 480ms cubic-bezier(.32,1.35,.45,1)",
          background: light ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.14)",
          boxShadow: light
            ? "0 2px 10px rgba(0,0,0,.10), 0 0 0 .5px rgba(0,0,0,.05)"
            : "0 1px 8px rgba(255,255,255,.08) inset, 0 0 0 .5px rgba(255,255,255,.22)",
          backdropFilter: "blur(10px) brightness(1.12)",
          WebkitBackdropFilter: "blur(10px) brightness(1.12)",
        }} />
        <div className="relative h-full grid grid-cols-4">
          {items.map(({ k, label, On, Off }) => {
            const on = tab === k;
            const Icon = on ? On : Off;
            return (
              <button key={k} onClick={() => setTab(k)}
                className="relative flex flex-col items-center justify-center gap-[2px] pressable"
                aria-current={on ? "page" : undefined}>
                <Icon size={21} style={{
                  color: on ? "var(--p-primary)" : (light ? "rgba(0,0,0,.42)" : "rgba(255,255,255,.62)"),
                  transition: "color 200ms, transform 320ms cubic-bezier(.32,1.35,.45,1)",
                  transform: on ? "scale(1.08) translateY(-1px)" : "scale(1)",
                }} />
                <span className="text-[9.5px] leading-none" style={{
                  fontWeight: on ? 700 : 500,
                  color: on ? "var(--p-primary)" : (light ? "rgba(0,0,0,.42)" : "rgba(255,255,255,.62)"),
                  transition: "color 200ms",
                }}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

/* ============ 堆栈页面 ============ */
function StackPage({ page, onBack, wide, top, bottomInset }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top} />;
  if (page.kind === "topics") return <TopicsPage onBack={onBack} wide={wide} />;
  if (page.kind === "topic") return <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "tags") return <TagsPage onBack={onBack} wide={wide} />;
  if (page.kind === "tag") return <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "following") return <FollowingPage onBack={onBack} wide={wide} />;
  if (page.kind === "user") return <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} />;
  return null;
}

/* ============ 应用主体 ============ */
function AppBody() {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs, clean } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (!fs && stack.length) pop(); return; } // 全屏时 Esc 只用来退出全屏（播放页自己处理）
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, fs]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = isMobile ? (fs || clean ? 0 : 74) : 14;
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）没有底栏，
     底部只让出安全区。之前多留了 20px，视频底边会露出一条
     「底栏」似的窄缝（底部的压暗渐变到不了屏幕最底）。 */
  const stackInset = isMobile ? 0 : 14;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!isMobile && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <div className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={bottomInset} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} active={pageActive && tab === "category"} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>

        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg a-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
          </div>
        ))}

        {isMobile && !fs && !clean && stack.length === 0 && <TabBar />}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS / Linux）============ */
const RAIL_KEY = "hghubx_rail_mode";
const readRailMode = (): RailMode => { try { return parseRailMode(localStorage.getItem(RAIL_KEY)); } catch { return "full"; } };

function DesktopShell() {
  const [railMode, setRailMode] = useState<RailMode>(readRailMode);
  const lastShown = useRef<RailMode>("full"); // Cmd/Ctrl+B 恢复时回到隐藏前的样子
  const { theater, platform, fs, setFs } = useStore();
  const fsRef = useRef(fs); fsRef.current = fs;
  useEffect(() => { try { localStorage.setItem(RAIL_KEY, railMode); } catch { /* ignore */ } }, [railMode]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setRailMode((m) => { const [next, remember] = toggleHidden(m, lastShown.current); lastShown.current = remember; return next; });
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  /* 用户用系统方式退出了窗口全屏（绿色按钮 / Cmd+Ctrl+F），界面也要退出沉浸模式，否则标题栏和侧栏会一直藏着。
     系统全屏有过渡动画，期间窗口可能短暂报告“不在全屏”：必须先确认进入过全屏，之后又不在了，才算外部退出。 */
  const seenFs = useRef(false);
  useEffect(() => { if (!fs) seenFs.current = false; }, [fs]);
  useEffect(() => {
    let un: (() => void) | undefined, alive = true;
    onWindowResized(() => {
      if (!fsRef.current) return;
      isWindowFullscreen().then((on) => {
        if (!alive) return;
        if (on) seenFs.current = true;
        else if (seenFs.current && fsRef.current) { seenFs.current = false; setFs(false); }
      });
    }).then((f) => { if (alive) un = f; else f(); });
    return () => { alive = false; un?.(); };
  }, [setFs]);
  /* 应用退出沉浸模式（Esc / 按钮 / 离开播放页）时，窗口也退出全屏；已经不在全屏就什么都不做 */
  const wasFs = useRef(false);
  useEffect(() => {
    if (wasFs.current && !fs) void setWindowFullscreen(false);
    wasFs.current = fs;
  }, [fs]);
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      {!fs && <DesktopTitleBar railMode={railMode} onToggle={() => setRailMode((m) => { const n = nextRailMode(m); if (n !== "hidden") lastShown.current = n; return n; })} />}
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={railMode === "compact" || theater} hideRail={railMode === "hidden" || theater || fs} theater={theater || fs} />
      </div>
      {/* 边缘缩放热区只对无边框窗口（Windows / Linux）有效，macOS 走原生窗口边框 */}
      {!fs && (platform === "windows" || platform === "linux") && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, hideRail, theater }: { collapsed: boolean; hideRail: boolean; theater: boolean }) {
  const { stack, pop, loginOpen, setLoginOpen, tab, setTab, platform, fs } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!hideRail && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <div className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={14} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} active={pageActive && tab === "category"} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>
        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg win-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={{ "--sat": "max(env(safe-area-inset-top), 12px)", "--sab": platform === "android" ? "max(env(safe-area-inset-bottom), 24px)" : "max(env(safe-area-inset-bottom), 16px)" } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs, gate, gateReady, nas, nasLoaded } = useStore();
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  /* iOS：长按快进会触发 WKWebView 系统文本选择放大镜（loupe），纯 CSS 挡不住。
     原生层已默认关闭文本交互（isTextInteractionEnabled=false）；这里在用户触碰输入框时
     重新打开、失焦时再关闭，避免影响搜索/评论/登录等文本输入。 */
  useEffect(() => {
    if (platform !== "ios") return;
    const setTI = (enabled: boolean) => setTextInteraction(enabled).catch(() => {});
    const INPUTS = 'input, textarea, [contenteditable="true"]';
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(INPUTS)) setTI(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(INPUTS)) setTI(false);
    };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [platform]);

  /* —— 安卓硬件返回键 ——
     层级：全屏 → 面板/弹层 → 登录框 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (runBack()) return;                                  // 播放器的选集/评论/图文面板
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    exitApp().catch(() => {});
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { logLine(r); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  if (!gateReady || !nasLoaded) {
    return <div className="absolute inset-0 bg-canvas" aria-busy="true" />;
  }
  // 启用了内置 NAS 服务：就绪之前不渲染业务界面（也就不会发出任何数据请求），只显示启动进度
  if (nas.enabled && nas.state !== "ready") {
    return <NasSplash />;
  }
  if (!gate.activated) {
    return <SourceGate />;
  }

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <LoginModal />
      <ToastHost />
      {/* 登录遮罩键盘处理占位 */}
      {loginOpen && <div className="hidden" onClick={() => setLoginOpen(false)} />}
    </>
  );
}
