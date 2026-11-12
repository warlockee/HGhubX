import { useEffect, useRef, useState, type FormEvent } from "react";
import { APP_NAME, APP_DESC } from "../branding";
import { useStore } from "../store";
import { isMobile } from "../api";
import { ILink, Logo } from "../icons";
import NasDialog from "./NasDialog";

/** 门牌页：未激活时只显示输入框，不做任何业务请求；任意非空字符串都交给 gate_open。 */
export default function SourceGate() {
  const { activateGate, gateBusy, gateError, gateReady } = useStore();
  const [value, setValue] = useState("");
  const [nasOpen, setNasOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (gateReady) inputRef.current?.focus();
  }, [gateReady]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (gateBusy) return;
    try {
      await activateGate(value);
    } catch {
      /* store 已记录 gateError，门牌页只负责展示 */
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas px-6 py-10 text-on">
      <div className="w-full max-w-[420px] a-rise">
        <div className="flex items-center gap-3 mb-8">
          <Logo size={48} />
          <div>
            <div className="text-[22px] font-bold tracking-tight leading-none">{APP_NAME}</div>
            <div className="text-[11px] text-mut mt-1.5">{APP_DESC}</div>
          </div>
        </div>

        <div className="text-[17px] font-semibold">接入地址</div>
        <div className="text-[12px] text-mut mt-1.5 leading-relaxed">
          输入地址后即可开始使用。地址只保存在本机，可随时在设置中更换。
        </div>

        <form onSubmit={submit} className="mt-5">
          <div className={`flex items-center gap-2 h-12 rounded-(--r-md) bg-s2 border px-3.5 transition-colors ${gateError ? "border-danger/60" : "border-s4/60 focus-within:border-primary/70"}`}>
            <ILink size={17} className="text-mut shrink-0" />
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
              placeholder="粘贴或输入地址"
              aria-label="接入地址"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent outline-none text-[14px] placeholder:text-dim"
            />
          </div>
          {gateError && <div className="text-[11.5px] text-danger mt-2">{gateError}</div>}
          <button
            type="submit"
            disabled={gateBusy || !value.trim()}
            className="mt-4 w-full h-11 rounded-(--r-md) bg-primary text-on-primary text-[14px] font-semibold pressable disabled:opacity-50 disabled:cursor-wait"
          >
            {gateBusy ? "连接中…" : "进入"}
          </button>
        </form>

        <div className="text-[10.5px] text-dim mt-6 leading-relaxed">
          不校验地址格式，也不探测服务器；输入什么就连接什么。
        </div>
        {!isMobile && (
          <button onClick={() => setNasOpen(true)} className="mt-4 text-[12px] text-primary pressable">
            或：把本机媒体目录作为片源（内置 NAS 服务）
          </button>
        )}
      </div>
      <NasDialog open={nasOpen} onClose={() => setNasOpen(false)} />
    </div>
  );
}
