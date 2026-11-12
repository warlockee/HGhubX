import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import type Hls from "hls.js";
import { mediaErrorMessage, mediaResource, usePlaybackActivity, usePlayerDiagnostics } from "./diagnostics";
import { createPlaybackEngine, type PlaybackEngine } from "./engine";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, source?: string) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const nearEndFiredRef = useRef(false);
  const [ready, setReady] = useState(false);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });

  const reportSize = (v: HTMLVideoElement | null) => {
    if (!v) return;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0) onSize?.(w, h);
  };

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, source = "handle") => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(t)) return;
      // iOS 上直接赋到 duration 会卡在 ended 态，夹到结尾前 0.15s
      const dur = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
      requestSeek(target, source);
      engineRef.current?.seek(target);
      const resume = !v.paused;
      try { v.currentTime = target; trace("seek.assigned", { target, source }); }
      catch (e) { trace("seek.rejected", { error_name: (e as Error).name }); throw e; }
      if (resume) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    },
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);
    nearEndFiredRef.current = false;
    const onVideoResize = () => reportSize(video);
    video.addEventListener("resize", onVideoResize);

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = rate;
    };

    const engine = createPlaybackEngine({
      video,
      src,
      autoPlay,
      trace,
      isActive: activity.isActive,
      play: activity.play,
      applySettings,
      onError: (detail) => onError?.(detail),
    });
    engineRef.current = engine;
    const engineHls = engine.hls;
    hlsRef.current = engineHls;

    return () => {
      video.removeEventListener("resize", onVideoResize);
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
      if (hlsRef.current === engineHls) hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // iOS 内联播放：部分 WKWebView 只认 HTML 属性
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  const handleVideoError = () => {
    if (hlsRef.current) return;
    onError?.(mediaErrorMessage(videoRef.current?.error ?? null));
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      preload="auto"
      muted={muted}
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={{ opacity: ready ? 1 : 0, transition: "opacity .35s" }}
      onLoadedData={(e) => {
        const v = e.target as HTMLVideoElement;
        setReady(true);
        reapply(v);
        reportSize(v);
      }}
      onTimeUpdate={(e) => {
        const v = e.target as HTMLVideoElement;
        reportSize(v);
        onTime?.(v.currentTime);
        // iOS 有时不触发 ended：靠近片尾自己补一次，保证自动连播
        const d = v.duration;
        if (d && Number.isFinite(d) && v.currentTime > d - 0.3 && !nearEndFiredRef.current) {
          nearEndFiredRef.current = true;
          onEnded?.();
        }
      }}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        reportSize(v);
      }}
      onDurationChange={(e) => { const d = (e.target as HTMLVideoElement).duration; if (d && Number.isFinite(d)) onDuration?.(d); }}
      onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={(e) => {
        reportSize(e.target as HTMLVideoElement);
        if (activity.isActive()) onPlaying?.();
      }}
      onEnded={() => { if (activity.isActive()) onEnded?.(); }}
      onError={handleVideoError}
    />
  );
});

export default VideoSurface;
