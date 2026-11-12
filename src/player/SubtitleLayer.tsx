import { useEffect, useState } from "react";
import { cueAt, cueLines, type Cue, type SubMode } from "../subtitles";

/** 字幕显示层：按视频当前时间（rAF 读取，比 timeupdate 的 250ms 精细）找到该显示的那条。
 *  不用 <track>：自定义协议下跨源字幕要 CORS 配合，而且我们要双语排版与延迟调整。 */
export default function SubtitleLayer({ cues, mode, translated, delay, getTime }: {
  cues: Cue[]; mode: SubMode; translated: boolean; delay: number; getTime: () => number;
}) {
  const [idx, setIdx] = useState(-1);

  useEffect(() => {
    if (!cues.length || mode === "off") { setIdx(-1); return; }
    let raf = 0, last = -2;
    const tick = () => {
      const i = cueAt(cues, getTime() - delay);
      if (i !== last) { last = i; setIdx(i); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cues, mode, delay, getTime]);

  if (idx < 0 || !cues[idx]) return null;
  const { main, sub } = cueLines(cues[idx], mode, translated);
  if (!main) return null;
  const shadow = "0 0 3px rgba(0,0,0,.95), 0 1px 4px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.6)";
  return (
    <div className="absolute inset-x-0 z-10 flex flex-col items-center gap-1 px-[8%] pointer-events-none text-center select-none"
      style={{ bottom: "12%" }} aria-live="off">
      <div className="font-semibold text-white leading-snug whitespace-pre-wrap" style={{ fontSize: "clamp(15px, 3.1vh, 28px)", textShadow: shadow }}>{main}</div>
      {sub && <div className="text-white/80 leading-snug whitespace-pre-wrap" style={{ fontSize: "clamp(12px, 2.1vh, 19px)", textShadow: shadow }}>{sub}</div>}
    </div>
  );
}
