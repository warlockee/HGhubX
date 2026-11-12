import { useCallback, useEffect, useRef, useState } from "react";
import { subApi, type Cue, type SubCaps, type SubStatus } from "../subtitles";

type Options = {
  /** 接入地址（门牌）；字幕接口挂在它下面 */
  base: string;
  videoId: number;
  ep: number;
  enabled: boolean;
  onDone?: () => void;
};

const capsCache = new Map<string, SubCaps | null>();

/** 当前视频的字幕：能力探测、状态轮询、生成 / 取消 / 删除、字幕内容加载。 */
export function useSubtitles({ base, videoId, ep, enabled, onDone }: Options) {
  const [caps, setCaps] = useState<SubCaps | null>(base ? capsCache.get(base) ?? null : null);
  const [status, setStatus] = useState<SubStatus>({ state: "idle" });
  const [cues, setCues] = useState<Cue[]>([]);
  const [translated, setTranslated] = useState(false);
  const [language, setLanguage] = useState("");
  const token = useRef("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const target = `${videoId}/${ep}`;

  /* 能力探测：其它数据源没有字幕接口，失败就当不支持（按 base 缓存，不重复探测） */
  useEffect(() => {
    if (!enabled || !base) return;
    if (capsCache.has(base)) { setCaps(capsCache.get(base) ?? null); return; }
    let alive = true;
    subApi.caps(base)
      .then((c) => { capsCache.set(base, c); if (alive) setCaps(c); })
      .catch(() => { capsCache.set(base, null); if (alive) setCaps(null); });
    return () => { alive = false; };
  }, [enabled, base]);
  const supported = !!caps;

  const loadCues = useCallback(async (version: string, forTarget: string) => {
    try {
      const doc = await subApi.cues(base, videoId, ep, version);
      if (token.current !== forTarget) return; // 已经切到别的视频
      setCues(doc.cues); setTranslated(doc.translated); setLanguage(doc.language);
    } catch { /* 读不到就当没有 */ }
  }, [base, videoId, ep]);

  /* 切视频 / 切集：重置并查一次状态，已有字幕就加载 */
  useEffect(() => {
    token.current = target;
    setStatus({ state: "idle" }); setCues([]); setTranslated(false); setLanguage("");
    if (!enabled || !supported || !videoId) return;
    let alive = true;
    subApi.status(base, videoId, ep).then((s) => {
      if (!alive || token.current !== target) return;
      setStatus(s);
      if (s.state === "done" && s.version) void loadCues(s.version, target);
    }).catch(() => {});
    return () => { alive = false; };
  }, [enabled, supported, base, videoId, ep, target, loadCues]);

  /* 排队 / 生成中：轮询进度；变成 done 就加载字幕并通知 */
  useEffect(() => {
    if (status.state !== "queued" && status.state !== "running") return;
    const forTarget = target;
    const timer = window.setInterval(() => {
      subApi.status(base, videoId, ep).then((s) => {
        if (token.current !== forTarget) return;
        setStatus(s);
        if (s.state === "done" && s.version) { void loadCues(s.version, forTarget); doneRef.current?.(); }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [status.state, base, videoId, ep, target, loadCues]);

  const start = useCallback(async (lang: string, force = false) => {
    setStatus(await subApi.start(base, videoId, ep, lang, force));
  }, [base, videoId, ep]);

  const cancel = useCallback(async () => {
    const s = await subApi.cancel(base, videoId, ep);
    setStatus(s);
  }, [base, videoId, ep]);

  const remove = useCallback(async () => {
    setStatus(await subApi.remove(base, videoId, ep));
    setCues([]); setTranslated(false); setLanguage("");
  }, [base, videoId, ep]);

  return { supported, caps, status, cues, translated, language, start, cancel, remove };
}
