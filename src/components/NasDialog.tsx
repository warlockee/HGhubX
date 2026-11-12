import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Modal } from "./ui";
import { IBoltF } from "../icons";
import NasStatusLine from "./NasStatusLine";

/** 内置 NAS 服务设置：媒体目录 / 端口 / 启停 / 状态与日志。设置页、首屏、启动页共用。 */
export default function NasDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { nas, configureNas, restartNas } = useStore();
  const [dir, setDir] = useState(nas.media_dir);
  const [port, setPort] = useState(String(nas.port));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDir(nas.media_dir); setPort(String(nas.port)); setErr(""); setShowLog(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async (fn: () => Promise<void>, close = false) => {
    setBusy(true); setErr("");
    try { await fn(); if (close) onClose(); }
    catch (e) { setErr((e as Error).message || "操作失败"); }
    finally { setBusy(false); }
  };
  const save = () => run(() => configureNas(true, dir, Number(port) || undefined), true);

  const field = "mt-1.5 flex items-center h-10 rounded-(--r-md) bg-s3 border border-s4/60 px-3 focus-within:border-primary/70";
  return (
    <Modal open={open} onClose={onClose} width={420}>
      <div className="p-5">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IBoltF size={16} /></span>
          <div>
            <div className="text-[14px] font-bold text-on">本机 NAS 服务</div>
            <div className="text-[10.5px] text-mut mt-0.5">随应用启动 / 退出，把媒体目录当作片源</div>
          </div>
        </div>

        <div className="mt-4 rounded-(--r-md) bg-s2 p-3"><NasStatusLine nas={nas} /></div>

        <label className="block mt-4 text-[11px] text-mut">媒体目录
          <div className={field}>
            <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/Volumes/share/media" aria-label="媒体目录"
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-on placeholder:text-dim" />
          </div>
        </label>
        <div className="text-[10.5px] text-dim mt-1.5 leading-relaxed">顶层文件夹名就是分类，每个视频文件是一个条目。需要先装好 Node.js 与 ffmpeg。</div>

        <label className="block mt-3 text-[11px] text-mut">端口
          <div className={`${field} w-28`}>
            <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" aria-label="端口"
              className="w-full bg-transparent outline-none text-[13px] text-on tabular-nums" />
          </div>
        </label>

        {err && <div className="text-[11px] text-danger mt-3 break-all">{err}</div>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on pressable">关闭</button>
          <button onClick={() => void save()} disabled={busy || !dir.trim()}
            className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-on-primary text-[12.5px] font-semibold pressable disabled:opacity-50">
            {busy ? "处理中…" : nas.enabled ? "保存并重启" : "启用并启动"}
          </button>
        </div>

        {nas.enabled && (
          <div className="flex items-center justify-between mt-3 text-[11px]">
            <button onClick={() => void run(restartNas)} disabled={busy} className="text-mut pressable disabled:opacity-50">重启服务</button>
            <button onClick={() => setShowLog((v) => !v)} className="text-mut pressable">{showLog ? "收起日志" : "查看日志"}</button>
            <button onClick={() => void run(() => configureNas(false, nas.media_dir, nas.port), true)} disabled={busy}
              className="text-danger pressable disabled:opacity-50">停用</button>
          </div>
        )}
        {showLog && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-(--r-sm) bg-s1 p-2 text-[10px] leading-snug text-mut whitespace-pre-wrap break-all">
            {nas.log.length ? nas.log.join("\n") : "（暂无日志）"}
          </pre>
        )}
      </div>
    </Modal>
  );
}
