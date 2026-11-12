import Hls from "hls.js";
import { isLocalMedia, mediaUrl, platform } from "../api";
import { mediaHost, mediaResource, observeHls, type PlaybackTrace } from "./diagnostics";

export type PlaybackEngineMode = "hls" | "native";

export type PlaybackEngine = {
  /** hls.js 实例；原生回退时为 null。 */
  hls: Hls | null;
  url: string;
  mode: PlaybackEngineMode;
  /** 拖动进度：先让 hls 从目标位置起载，再赋值 currentTime。 */
  seek: (time: number) => void;
  destroy: () => void;
};

export type PlaybackEngineOptions = {
  video: HTMLVideoElement;
  src: string;
  autoPlay: boolean;
  trace: PlaybackTrace;
  isActive: () => boolean;
  play: (source: string, automatic?: boolean) => void;
  onBuffered?: () => void;
  onError?: (detail: string) => void;
  /** 换源后重新套用音量/静音/倍速等本地设置。 */
  applySettings?: () => void;
};

const HLS_CONFIG = {
  // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
  interstitialsController: undefined,
  contentSteeringController: undefined,
  enableInterstitialPlayback: false,
  // WKWebView 里 hls.js 的 worker 不稳，iOS 关掉。
  enableWorker: platform !== "ios",
  // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
  preferManagedMediaSource: false,
  autoStartLoad: false,
  lowLatencyMode: false,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  maxBufferSize: 120 * 1000 * 1000,
  backBufferLength: 90,
  maxBufferHole: 0.5,
  nudgeOffset: 0.25,
  nudgeMaxRetry: 6,
  manifestLoadingTimeOut: 20000,
  manifestLoadingMaxRetry: 4,
  fragLoadingTimeOut: 25000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 400,
};

/**
 * 统一的播放引擎：负责把原始地址解析成本地代理地址、创建/销毁 hls.js、
 * 处理 NETWORK/MEDIA 错误恢复，以及在原生 HLS 下回退到 <video>。
 *
 * 页面组件只通过 PlaybackEngine 操作媒体，不再各自 new Hls。
 */
export function createPlaybackEngine({
  video, src, autoPlay, trace, isActive, play, onBuffered, onError, applySettings,
}: PlaybackEngineOptions): PlaybackEngine {
  // m3u8 走 hls.js；mp4 等原文件走原生 <video>，经本地协议按 Range 取流（拖动进度条不用等切片）
  const url = isLocalMedia(src) ? src : mediaUrl(src);
  const mode: PlaybackEngineMode = !url.includes("/seg?u=") && Hls.isSupported() ? "hls" : "native";
  trace("source.load", {
    engine: mode === "hls" ? "hls.js" : "native",
    auto_play: autoPlay,
    resource: mediaResource(src),
    host: mediaHost(src),
  });
  applySettings?.();

  let hls: Hls | null = null;
  let recoverCount = 0;
  let recoverTimer: number | null = null;
  let destroyed = false;

  const clearTimer = () => {
    if (recoverTimer != null) {
      window.clearTimeout(recoverTimer);
      recoverTimer = null;
    }
  };

  if (mode === "native") {
    video.src = url;
    if (autoPlay) play("native_autoplay", true);
    return {
      hls: null,
      url,
      mode,
      seek: (time: number) => { video.currentTime = time; },
      destroy: () => { destroyed = true; trace("source.cleanup"); },
    };
  }

  hls = new Hls(HLS_CONFIG);
  observeHls(hls, trace);
  hls.loadSource(url);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    applySettings?.();
    if (isActive()) hls?.startLoad();
    if (autoPlay) play("manifest_autoplay", true);
  });
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    recoverCount = 0;
    onBuffered?.();
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (destroyed) return;
    if (!data.fatal) {
      if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR || data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR) {
        try { hls?.startLoad(video.currentTime || -1); } catch { /* ignore */ }
      }
      return;
    }
    if (!isActive()) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCount < 4) {
      recoverCount += 1;
      const delay = 250 * recoverCount;
      clearTimer();
      trace("engine.retry", { type: data.type, detail: data.details, attempt: recoverCount, delay_ms: delay });
      recoverTimer = window.setTimeout(() => {
        if (!destroyed && isActive()) { try { hls?.startLoad(video.currentTime || -1); } catch { /* ignore */ } }
      }, delay);
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCount < 4) {
      recoverCount += 1;
      const delay = 250 * recoverCount;
      clearTimer();
      trace("engine.retry", { type: data.type, detail: data.details, attempt: recoverCount, delay_ms: delay });
      recoverTimer = window.setTimeout(() => {
        if (!destroyed && isActive()) {
          try { hls?.recoverMediaError(); void video.play().catch(() => {}); } catch { /* ignore */ }
        }
      }, delay);
      return;
    }
    const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
    onError?.(detail);
    if (!isActive()) return;
    // 最后一次恢复尝试与旧播放器保持一致：能救则救，救不回来由页面显示错误。
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls?.startLoad(); } catch { /* ignore */ } }
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls?.recoverMediaError(); } catch { /* ignore */ } }
    else { try { hls?.destroy(); } catch { /* ignore */ } hls = null; }
  });

  return {
    get hls() { return hls; },
    url,
    mode,
    seek: (time: number) => {
      if (hls) { try { hls.startLoad(time); } catch { /* ignore */ } }
      video.currentTime = time;
    },
    destroy: () => {
      destroyed = true;
      clearTimer();
      trace("source.cleanup");
      if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
    },
  };
}
