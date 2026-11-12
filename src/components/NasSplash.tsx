import { useState } from "react";
import { APP_NAME } from "../branding";
import { useStore } from "../store";
import { Logo } from "../icons";
import NasDialog from "./NasDialog";
import { NasDot } from "./NasStatusLine";

/** 启用了内置 NAS 服务、但服务还没就绪时挡在最前面：显示启动进度；出错给出原因与出路。 */
export default function NasSplash() {
  const { nas, restartNas, configureNas, toast } = useStore();
  const [dialog, setDialog] = useState(false);
  const failed = nas.state === "error";
  const lastLogs = nas.log.slice(-4);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas px-6 py-10 text-on" role="status" aria-live="polite">
      <div className="w-full max-w-[420px] a-rise">
        <div className="flex items-center gap-3 mb-8">
          <Logo size={48} />
          <div className="text-[22px] font-bold tracking-tight leading-none">{APP_NAME}</div>
        </div>

        <div className="flex items-center gap-2.5">
          {failed ? <NasDot state="error" /> : <div className="w-[18px] h-[18px] spinner" />}
          <div className="text-[17px] font-semibold">{failed ? "NAS 服务启动失败" : "正在启动 NAS 服务"}</div>
        </div>
        <div className={`text-[12.5px] mt-2 leading-relaxed break-all ${failed ? "text-danger" : "text-mut"}`}>{nas.message || "请稍候…"}</div>
        {nas.media_dir && <div className="text-[11px] text-dim mt-1 break-all">媒体目录：{nas.media_dir}</div>}

        {!failed && nas.videos != null && (
          <div className="mt-3 text-[12px] text-on tabular-nums">已发现 {nas.videos} 个视频{nas.categories != null ? ` · ${nas.categories} 个分类` : ""}</div>
        )}

        {lastLogs.length > 0 && (
          <pre className="mt-4 max-h-24 overflow-hidden rounded-(--r-sm) bg-s1 p-2 text-[10px] leading-snug text-mut whitespace-pre-wrap break-all">{lastLogs.join("\n")}</pre>
        )}

        {failed && (
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button onClick={() => void restartNas()} className="h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-semibold pressable">重试</button>
            <button onClick={() => setDialog(true)} className="h-10 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">修改设置</button>
            <button
              onClick={() => void configureNas(false, nas.media_dir, nas.port).catch((e) => toast((e as Error).message, "info"))}
              className="col-span-2 h-9 text-[11.5px] text-mut pressable">停用内置服务，改用手动接入地址</button>
          </div>
        )}
      </div>
      <NasDialog open={dialog} onClose={() => setDialog(false)} />
    </div>
  );
}
