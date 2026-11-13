import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  GateState,
  NasStatus,
  UpdateInfo,
} from "./types";

/** 壳层命令门面：只放非业务命令，业务数据统一走 data/client.ts。 */

/** 写一行到应用数据目录 debug.log（用户反馈「打不开」时要的就是它）。 */
export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

export const gateState = () => invoke<GateState>("gate_state");
export const gateOpen = (address: string) => invoke<GateState>("gate_open", { address });
export const gateReset = () => invoke<GateState>("gate_reset");

export const securitySet = (strict: boolean) => invoke<boolean>("security_set", { strict });

export const clearCache = () => invoke<void>("cache_clear");
export const netDiag = () => invoke<Record<string, unknown>>("net_diag");
/** 系统方向请求；页面不直接 invoke，统一从门面走。 */
export const setOrientation = (landscape: boolean) => invoke<void>("set_orientation", { landscape });

/* 更新与应用控制 */
export const checkUpdate = () => invoke<UpdateInfo>("check_update");
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** iOS 文本交互开关：长按快进时避免 WKWebView 放大镜。 */
export const setTextInteraction = (enabled: boolean) =>
  invoke<void>("set_text_interaction", { enabled });

/** 安卓硬件返回键走到桌面后退出应用。 */
export const exitApp = () => invoke<void>("plugin:app|exit", { code: 0 });

/* 内置 NAS 服务（随应用启动的本机后端） */
export const nasStatus = () => invoke<NasStatus>("nas_status");
export const nasConfigure = (enabled: boolean, mediaDir: string, port?: number) =>
  invoke<NasStatus>("nas_configure", { enabled, mediaDir, port });
export const nasRestart = () => invoke<NasStatus>("nas_restart");
export const onNasStatus = (fn: (s: NasStatus) => void): Promise<UnlistenFn> =>
  listen<NasStatus>("nas-status", (e) => fn(e.payload));

/** 桌面窗口全屏开关（应用自己控制，不依赖网页的 requestFullscreen——它在 WebView 里没有可靠效果）。失败只记日志，不抛出。 */
export const setWindowFullscreen = async (on: boolean): Promise<void> => {
  try { await getCurrentWindow().setFullscreen(on); }
  catch (e) { void logLine(`[fullscreen] setFullscreen(${on}) failed: ${String(e)}`); }
};
/** 窗口当前是否处于全屏（用户用系统方式退出全屏时，界面要跟着退出沉浸模式） */
export const isWindowFullscreen = async (): Promise<boolean> => {
  try { return await getCurrentWindow().isFullscreen(); } catch { return false; }
};
/** 窗口尺寸 / 全屏状态变化的订阅；订阅不了就返回空的取消函数 */
export const onWindowResized = async (cb: () => void): Promise<UnlistenFn> => {
  try { return await getCurrentWindow().onResized(cb); } catch { return () => {}; }
};
