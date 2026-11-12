import { useState } from "react";
import { LANGS, langName, type SubCaps, type SubMode, type SubStatus } from "../subtitles";

const STAGE: Record<string, string> = { queued: "排队中", extract: "提取音频", transcribe: "识别语音", translate: "翻译成中文" };
const MODES: { mode: SubMode; label: string; needsZh?: boolean }[] = [
  { mode: "off", label: "关闭" }, { mode: "zh", label: "中文", needsZh: true },
  { mode: "orig", label: "原文" }, { mode: "both", label: "双语", needsZh: true },
];

type Props = {
  caps: SubCaps;
  status: SubStatus;
  mode: SubMode;
  translated: boolean;
  language: string;
  count: number;
  onMode: (m: SubMode) => void;
  onStart: (lang: string, force: boolean) => Promise<void>;
  onCancel: () => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
  desktop: boolean;
};

/** 字幕菜单：生成（选语言）/ 进度 / 显示模式。本地语音识别 + 翻译，音频和台词不出本机。 */
export default function SubtitleMenu({ caps, status, mode, translated, language, count, onMode, onStart, onCancel, onRemove, onClose, desktop }: Props) {
  const [lang, setLang] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [regen, setRegen] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message || "操作失败"); } finally { setBusy(false); }
  };

  const chip = (on: boolean) => `h-8 px-3 rounded-full text-[12px] pressable ${on ? "bg-primary text-on-primary font-semibold" : "bg-s3 text-on"}`;
  const pct = Math.round((status.progress ?? 0) * 100);
  const running = status.state === "queued" || status.state === "running";
  const showPicker = status.state === "idle" || status.state === "error" || (status.state === "done" && regen);

  const picker = (
    <>
      <div className="text-[11px] text-mut mb-2">视频里说的是什么语言？</div>
      <div className="flex flex-wrap gap-1.5">
        {LANGS.map((l) => <button key={l.code} onClick={() => setLang(l.code)} className={chip(lang === l.code)}>{l.name}</button>)}
      </div>
      {lang === "auto" && <div className="text-[10.5px] text-dim mt-2 leading-relaxed">开头是音乐或没人说话时自动识别可能判错，已知语言时建议直接选。</div>}
      <button disabled={busy} onClick={() => void act(async () => { await onStart(lang, status.state === "done"); setRegen(false); })}
        className="mt-3 w-full h-9 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-semibold pressable disabled:opacity-50">
        {status.state === "done" ? "重新生成" : "生成字幕"}
      </button>
      <div className="text-[10.5px] text-dim mt-2 leading-relaxed">在本机识别并翻译成中文，音频和台词不会上传；生成期间可以继续观看。</div>
    </>
  );

  return (
    <>
      <div className="absolute inset-0 z-30" onClick={onClose} />
      <div role="dialog" aria-label="字幕"
        className={`absolute z-40 rounded-(--r-md) bg-s1/95 backdrop-blur-md elev-3 p-4 text-on ${desktop ? "right-4 w-[320px]" : "inset-x-3"}`}
        style={{ bottom: desktop ? 96 : 92 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[14px] font-bold">字幕</div>
          <button onClick={onClose} aria-label="关闭" className="text-mut text-[18px] leading-none pressable px-1">×</button>
        </div>

        {!caps.asr ? (
          <div className="text-[12px] text-mut leading-relaxed">
            还没有安装字幕组件：{caps.missing.join("、") || "语音识别"}。
            <div className="mt-2 rounded-(--r-sm) bg-s3 px-2.5 py-2 text-[11px] text-on break-all select-text">{caps.note || "运行 nas-backend/setup-subtitles.sh"}</div>
          </div>
        ) : running ? (
          <>
            <div className="flex items-center justify-between text-[12.5px]">
              <span>{STAGE[status.stage || "queued"] || status.message}{status.state === "queued" && status.queued ? `（前面还有 ${status.queued - 1} 个）` : ""}</span>
              <span className="tabular-nums text-mut">{status.state === "queued" ? "" : `${pct}%`}</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-s3 overflow-hidden"><div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} /></div>
            <div className="text-[10.5px] text-dim mt-2">{status.language ? `识别语言：${langName(status.language)} · ` : ""}可以继续观看，完成后自动显示</div>
            <button disabled={busy} onClick={() => void act(onCancel)} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] pressable disabled:opacity-50">取消</button>
          </>
        ) : status.state === "done" && !regen ? (
          <>
            <div className="grid grid-cols-4 gap-1.5">
              {MODES.map((m) => {
                const disabled = !!m.needsZh && !translated;
                return (
                  <button key={m.mode} disabled={disabled} onClick={() => onMode(m.mode)}
                    className={`h-9 rounded-(--r-ctl) text-[12.5px] pressable disabled:opacity-35 ${mode === m.mode ? "bg-primary text-on-primary font-semibold" : "bg-s3 text-on"}`}>{m.label}</button>
                );
              })}
            </div>
            <div className="text-[10.5px] text-dim mt-2.5 leading-relaxed">
              识别语言：{langName(language)} · 共 {count} 条{translated ? "" : " · 仅原文（未翻译）"}
              {status.message ? ` · ${status.message}` : ""}
            </div>
            <div className="text-[10.5px] text-dim mt-1">快捷键：V 切换显示，[ ] 调整字幕快慢</div>
            <div className="flex items-center justify-between mt-3 text-[11.5px]">
              <button onClick={() => setRegen(true)} className="text-mut pressable">重新生成…</button>
              <button disabled={busy} onClick={() => void act(onRemove)} className="text-danger pressable disabled:opacity-50">删除字幕</button>
            </div>
          </>
        ) : showPicker ? (
          <>
            {status.state === "error" && <div className="text-[11.5px] text-danger mb-3 break-all">生成失败：{status.message}</div>}
            {picker}
            {regen && <button onClick={() => setRegen(false)} className="mt-2 w-full text-center text-[11.5px] text-mut pressable">返回</button>}
          </>
        ) : null}

        {err && <div className="text-[11px] text-danger mt-2 break-all">{err}</div>}
      </div>
    </>
  );
}
