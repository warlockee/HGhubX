import type { NasStatus } from "../types";

/** 状态圆点：就绪绿 / 启动中琥珀（呼吸） / 出错红 / 未启用灰。 */
export function NasDot({ state }: { state: NasStatus["state"] }) {
  const cls =
    state === "ready" ? "bg-green-500"
    : state === "starting" ? "bg-amber-400 animate-pulse"
    : state === "error" ? "bg-danger"
    : "bg-s4";
  return <span aria-hidden className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

export const nasStateText = (n: NasStatus): string =>
  n.state === "ready" ? "运行中"
  : n.state === "starting" ? "启动中"
  : n.state === "error" ? "启动失败"
  : n.enabled ? "已启用" : "未启用";

/** 一行状态：圆点 + 状态 + 说明（媒体库规模 / 当前阶段 / 错误）。 */
export default function NasStatusLine({ nas }: { nas: NasStatus }) {
  const detail =
    nas.state === "ready" ? `${nas.videos ?? 0} 个视频 · ${nas.categories ?? 0} 个分类 · 端口 ${nas.port}`
    : nas.message;
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="mt-[5px]"><NasDot state={nas.state} /></span>
      <div className="min-w-0">
        <div className={`text-[12.5px] ${nas.state === "error" ? "text-danger" : "text-on"}`}>{nasStateText(nas)}</div>
        {detail && <div className={`text-[10.5px] break-all ${nas.state === "error" ? "text-danger/90" : "text-mut"}`}>{detail}</div>}
      </div>
    </div>
  );
}
