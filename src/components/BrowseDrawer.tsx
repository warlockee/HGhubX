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
export default function BrowseDrawer({ wide }: { wide: boolean }) {
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

  if (!open) return null;
  const width = wide ? 380 : undefined;

  return (
    <aside role="complementary" aria-label="片库与队列"
      className="absolute top-0 bottom-0 right-0 z-30 flex flex-col bg-black/80 backdrop-blur-xl text-white border-l border-white/10"
      style={{ width: width ?? "min(100%, 420px)", paddingTop: "var(--sat, 0px)" }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setBrowse({ open: false }); } }}>
      <div className="shrink-0 flex items-center gap-1 px-3 pt-3 pb-2">
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
  );
}
