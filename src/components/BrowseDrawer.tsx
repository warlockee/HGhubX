import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { Img } from "./ui";
import { IClose, INext, IPlayF, IPlus, ISearch, ITrash, IChevronUp } from "../icons";
import type { QueueItem } from "../queue";

type Channel = { cate: string; name: string };
const PAGE = 30;
const ALL = "__all__";
const toItem = (v: VideoCard): QueueItem => ({ id: v.id, title: v.title, cover: v.cover });

const Thumb = ({ src }: { src: string }) => (
  <div className="relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s1" style={{ aspectRatio: "16 / 10" }}><Img src={src} /></div>
);
const Btn = ({ title, onClick, children, on = false }: { title: string; onClick: () => void; children: React.ReactNode; on?: boolean }) => (
  <button title={title} aria-label={title} onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`w-8 h-8 rounded-full flex items-center justify-center pressable ${on ? "bg-white/90 text-black" : "bg-white/10 text-white hover:bg-white/20"}`}>
    {children}
  </button>
);


/** 主播放器旁边的“片库 / 队列”抽屉：边看边逛，把想看的加进队列。
 *  播放器一直在后面播，这里只负责挑片子，所以不会打断当前的视频。 */
const WIDE_W = 380;
export default function BrowseDrawer({ wide, onReveal }: { wide: boolean; onReveal?: (px: number, dragging: boolean) => void }) {
  const { browse, setBrowse, queue, enqueue, dequeue, promote, clearQueue, playNow, toast, libraryEpoch } = useStore();
  const { open, tab } = browse;

  const [channels, setChannels] = useState<Channel[]>([]);
  const [cate, setCate] = useState(ALL);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seqRef = useRef(0);
  const loadedOnce = useRef(false);

  const inQueue = useCallback((id: number) => queue.some((x) => x.id === id), [queue]);

  const loadChannels = useCallback(async () => {
    try {
      const res = await api.tags();
      const seen = new Set<string>();
      const list: Channel[] = [];
      for (const g of res?.categories || []) for (const t of g.tags || []) {
        const c = t.slug || t.name;
        if (!c || seen.has(c)) continue;
        seen.add(c); list.push({ cate: c, name: t.name || c });
      }
      setChannels(list);
    } catch { /* 分类取不到不影响浏览全部 */ }
  }, []);

  /* 取一页：分类 / 搜索 / 全部。seq 防止切分类时旧请求把新结果盖掉 */
  const load = useCallback(async (p: number, reset: boolean) => {
    const mine = ++seqRef.current;
    setLoading(true); setError("");
    try {
      const keyword = q.trim();
      const res = keyword ? await api.search(keyword, p, PAGE, "video")
        : cate === ALL ? await api.feed(p, PAGE)
        : await api.category(cate, p, PAGE);
      if (mine !== seqRef.current) return;
      const list = res?.items || [];
      setItems((prev) => (reset ? list : [...prev, ...list.filter((v) => !prev.some((x) => x.id === v.id))]));
      setPage(p);
      setDone(!list.length || (!!res?.pagination && p >= res.pagination.pages));
    } catch (e) {
      if (mine === seqRef.current) setError((e as Error).message || "加载失败");
    } finally {
      if (mine === seqRef.current) setLoading(false);
    }
  }, [q, cate]);

  /* 第一次展开才加载；换分类 / 搜索词（防抖）/ 片库变化后重新拉第一页 */
  useEffect(() => {
    if (!open) return;
    if (!loadedOnce.current) { loadedOnce.current = true; void loadChannels(); }
    const t = window.setTimeout(() => { setItems([]); setDone(false); void load(1, true); }, q ? 350 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cate, q, libraryEpoch]);

  const listRef = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = listRef.current;
    if (!el || loading || done || error) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) void load(page + 1, false);
  };

  /* —— 滑入 / 滑出：translateX 做动画；顶部标签栏和右缘的把手可以跟手拖动，松手按位置和速度决定收起还是展开 —— */
  const asideRef = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState<number | null>(null); // 拖动中的 translateX（px），null = 不在拖
  const gesture = useRef<{ x: number; base: number; t: number; moved: boolean; last: number } | null>(null);
  const widthPx = () => asideRef.current?.offsetWidth || (wide ? WIDE_W : 380);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input")) { if (!(e.target as HTMLElement).closest("[data-grip]")) return; }
    gesture.current = { x: e.clientX, base: open ? 0 : widthPx(), t: Date.now(), moved: false, last: e.clientX };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    if (Math.abs(dx) > 4) g.moved = true;
    g.last = e.clientX;
    if (g.moved) setDrag(Math.max(0, Math.min(widthPx(), g.base + dx)));
  };
  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const W = widthPx();
    const at = drag ?? g.base;
    const speed = (g.last - g.x) / Math.max(1, Date.now() - g.t); // px/ms，向右为正
    setDrag(null);
    if (!g.moved) { if (!open) setBrowse({ open: true }); return; } // 点一下把手 = 展开
    const wantOpen = speed > 0.5 ? false : speed < -0.5 ? true : at < W / 2;
    setBrowse({ open: wantOpen });
  };
  const offset = drag ?? (open ? 0 : widthPx());
  useEffect(() => { onReveal?.(Math.max(0, widthPx() - offset), drag != null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset, drag, wide]);

  return (
    <>
    {/* 收起时贴在右缘的把手：点一下展开，或向左拖出来 */}
    <div data-grip role="button" aria-label="拉出片库" title="拉出片库"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      className="absolute z-20 right-0 top-1/2 -translate-y-1/2 w-[18px] h-[72px] rounded-l-xl bg-black/55 backdrop-blur flex items-center justify-center cursor-grab touch-none"
      style={{ opacity: open || drag != null ? 0 : 1, pointerEvents: open || drag != null ? "none" : "auto", transition: "opacity 200ms" }}>
      <span className="block w-[3px] h-8 rounded-full bg-white/60" />
    </div>
    <aside ref={asideRef} role="complementary" aria-label="片库与队列" aria-hidden={!open && drag == null}
      {...(!open && drag == null ? { inert: true } : {})}
      className="absolute top-0 bottom-0 right-0 z-30 flex flex-col bg-black/80 backdrop-blur-xl text-white border-l border-white/10"
      style={{ width: wide ? WIDE_W : "min(100%, 420px)", paddingTop: "var(--sat, 0px)", transform: `translateX(${offset}px)`,
        transition: drag != null ? "none" : "transform 300ms cubic-bezier(.32,.72,0,1)", visibility: !open && drag == null ? undefined : "visible" }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setBrowse({ open: false }); } }}>
      <div className="shrink-0 flex items-center gap-1 px-3 pt-3 pb-2 touch-none cursor-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {([["browse", "片库"], ["queue", `队列${queue.length ? ` · ${queue.length}` : ""}`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setBrowse({ tab: k })} aria-pressed={tab === k}
            className={`px-3 h-8 rounded-full text-[13px] font-semibold pressable ${tab === k ? "bg-white text-black" : "bg-white/10 text-white/80 hover:bg-white/15"}`}>{label}</button>
        ))}
        <div className="flex-1" />
        <button aria-label="收起" title="收起 (Q)" onClick={() => setBrowse({ open: false })} className="w-8 h-8 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 pressable"><IClose size={16} /></button>
      </div>

      {tab === "browse" ? (
        <>
          <div className="shrink-0 px-3 pb-2">
            <div className="flex items-center gap-2 h-9 px-3 rounded-full bg-white/10">
              <ISearch size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索片名" aria-label="搜索片名"
                className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-white/40" />
              {q && <button aria-label="清除搜索" onClick={() => setQ("")} className="text-white/60"><IClose size={13} /></button>}
            </div>
          </div>
          {!q && (
            <div className="shrink-0 flex gap-1.5 overflow-x-auto px-3 pb-2 no-scrollbar" role="tablist" aria-label="分类">
              {[{ cate: ALL, name: "全部" }, ...channels].map((c) => (
                <button key={c.cate} role="tab" aria-selected={cate === c.cate} onClick={() => setCate(c.cate)}
                  className={`shrink-0 px-3 h-7 rounded-full text-[12px] pressable ${cate === c.cate ? "bg-white text-black font-semibold" : "bg-white/10 text-white/80 hover:bg-white/15"}`}>{c.name}</button>
              ))}
            </div>
          )}
          <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 pb-4 space-y-2">
            {items.map((v) => (
              <div key={v.id} className="flex items-center gap-2.5 p-1.5 rounded-(--r-md) hover:bg-white/8 group">
                <button onClick={() => playNow(toItem(v))} className="flex items-center gap-2.5 flex-1 min-w-0 text-left" title="立即播放">
                  <Thumb src={v.cover} />
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium clamp-2 leading-snug">{v.title}</div>
                    <div className="text-[10.5px] text-white/50 mt-0.5 clamp-1">{[v.duration, ...(v.tags || []).slice(0, 2)].filter(Boolean).join(" · ")}</div>
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <Btn title="下一个播放" onClick={() => { enqueue(toItem(v), true); toast("将作为下一个播放", "info"); }}><INext size={14} /></Btn>
                  <Btn title={inQueue(v.id) ? "已在队列（再点移到队尾）" : "加入队列"} on={inQueue(v.id)} onClick={() => { enqueue(toItem(v)); toast("已加入队列", "info"); }}><IPlus size={15} /></Btn>
                </div>
              </div>
            ))}
            {loading && <div className="py-4 flex justify-center"><div className="w-6 h-6 spinner" /></div>}
            {!loading && error && <button className="w-full py-3 text-[12px] text-white/70 underline" onClick={() => void load(items.length ? page + 1 : 1, !items.length)}>{error}，点击重试</button>}
            {!loading && !error && !items.length && <div className="py-10 text-center text-[12px] text-white/50">{q ? "没有找到" : "暂无视频"}</div>}
          </div>
        </>
      ) : (
        <>
          <div className="shrink-0 flex items-center px-4 pb-2 text-[12px] text-white/60">
            <span>{queue.length ? `接下来播放 ${queue.length} 部` : "队列是空的"}</span>
            <div className="flex-1" />
            {queue.length > 0 && (
              <button onClick={() => { clearQueue(); toast("已清空队列", "info"); }} className="flex items-center gap-1 px-2.5 h-7 rounded-full bg-white/10 hover:bg-white/20 pressable text-white"><ITrash size={13} />清空</button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-2">
            {queue.map((v, i) => (
              <div key={v.id} className="flex items-center gap-2.5 p-1.5 rounded-(--r-md) bg-white/5">
                <span className="w-5 text-center text-[11px] text-white/45 shrink-0">{i + 1}</span>
                <Thumb src={v.cover} />
                <div className="min-w-0 flex-1 text-[12.5px] font-medium clamp-2 leading-snug">{v.title}</div>
                <div className="flex items-center gap-1 shrink-0">
                  <Btn title="立即播放" onClick={() => playNow(v)}><IPlayF size={13} /></Btn>
                  {i > 0 && <Btn title="移到最前" onClick={() => promote(v.id)}><IChevronUp size={14} /></Btn>}
                  <Btn title="从队列移除" onClick={() => dequeue(v.id)}><IClose size={14} /></Btn>
                </div>
              </div>
            ))}
            {!queue.length && (
              <div className="py-10 px-6 text-center text-[12px] leading-relaxed text-white/50">
                在“片库”里点 <span className="text-white">＋</span> 加入队列，点 <span className="text-white">⏭</span> 设为下一个。<br />当前视频播完后会自动接着播队列里的。
              </div>
            )}
          </div>
        </>
      )}
    </aside>
    </>
  );
}
