import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { Masonry, RowCard } from "../components/cards";
import { InplaceSearch } from "../components/InplaceSearch";
import { Empty } from "../components/ui";
import { IBack, IChevR, IGlobe, IGrid, ISearch, ITrophy } from "../icons";

/** 分类由后端按内容动态给出（api.tags），客户端不再写死任何频道 */
type Channel = { cate: string; name: string };

/* ================= 分类总览 ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineEpoch } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [listState, setListState] = useState<{ loading: boolean; error: string }>({ loading: true, error: "" });
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const retryKeys = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string): Promise<void> => {
    if (pending.current.has(key)) return;
    const requestEpoch = lineEpochRef.current;
    pending.current.add(key);
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      const result = await api.category(key, 1, 8);
      if (mounted.current) {
        setRows(m => ({ ...m, [key]: result?.items || [] }));
        setTotals(m => ({ ...m, [key]: result?.pagination?.total ?? (result?.items || []).length }));
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || "加载失败" }));
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale) retryKeys.current.add(key);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
      const retry = retryKeys.current.delete(key);
      if (retry && mounted.current) void loadPreview(key);
    }
  }, []);

  const loadChannels = useCallback(async () => {
    setListState({ loading: true, error: "" });
    try {
      const res = await api.tags();
      const seen = new Set<string>();
      const list: Channel[] = [];
      for (const group of res?.categories || []) {
        for (const tag of group.tags || []) {
          const cate = tag.slug || tag.name;
          if (!cate || seen.has(cate)) continue;
          seen.add(cate);
          list.push({ cate, name: tag.name || cate });
        }
      }
      if (!mounted.current) return;
      setChannels(list);
      setListState({ loading: false, error: "" });
      list.forEach(c => { void loadPreview(c.cate); });
    } catch (error) {
      if (mounted.current) setListState({ loading: false, error: (error as Error).message || "加载失败" });
    }
  }, [loadPreview]);

  useEffect(() => {
    // 首次打开分类才加载，避免启动时后台请求/封面与首页视频竞争网络。
    if (!active || started.current) return;
    started.current = true;
    void loadChannels();
  }, [active, loadChannels]);

  /* 线路切换后：已打开过的分类里，加载失败的栏目在新线路上重试一次 */
  useEffect(() => {
    if (!lineEpoch || !started.current) return;
    Object.entries(errorsRef.current).forEach(([key, msg]) => { if (msg) void loadPreview(key); });
  }, [lineEpoch, loadPreview]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-1" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="flex items-end gap-2.5">
          <span className="text-[24px] font-bold text-on leading-none">分类</span>
          <span className="text-[11px] text-mut pb-0.5">{listState.loading ? "加载中…" : `${channels.length} 个分类`}</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2">
        {/* 排行榜入口 */}
        <button onClick={() => push({ kind: "ranks" })}
          className="mx-4 mb-2.5 w-[calc(100%-2rem)] flex items-center gap-3 rounded-(--r-md) bg-s2 p-3.5 text-left pressable elev-1">
          <span className="w-10 h-10 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0"><ITrophy size={20} /></span>
          <span className="flex-1">
            <span className="block text-[14.5px] font-semibold text-on">排行榜</span>
            <span className="block text-[10.5px] text-mut mt-0.5">热播榜 · 推荐榜 · 潜力榜</span>
          </span>
          <IChevR size={16} className="text-mut" />
        </button>

        {/* 标签入口 */}
        <button onClick={() => push({ kind: "tags" })}
          className="mx-4 mb-5 w-[calc(100%-2rem)] flex items-center gap-3 rounded-(--r-md) bg-s2 p-3 text-left pressable elev-1">
          <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0"><IGlobe size={18} /></span>
          <span className="flex-1">
            <span className="block text-[13.5px] font-semibold text-on">全部标签</span>
            <span className="block text-[10px] text-mut mt-0.5">按文件夹与子目录找片</span>
          </span>
          <IChevR size={14} className="text-mut" />
        </button>

        {channels.map((c, ci) => {
          const list = rows[c.cate] || [];
          return (
            <section key={c.cate} aria-label={c.name} className="mb-5 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <button onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
                <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
                  <IGrid size={19} strokeWidth={1.9} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold text-on leading-tight">{c.name}</span>
                  <span className="block text-[10.5px] text-mut mt-0.5 truncate">{totals[c.cate] != null ? `共 ${totals[c.cate]} 部` : "加载中…"}</span>
                </span>
                <span className="flex items-center gap-0.5 text-[11.5px] text-mut group-hover:text-primary transition-colors">
                  全部<IChevR size={14} />
                </span>
              </button>
              <div className="scroll-x flex gap-2.5 px-4 snap-x">
                {list.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: c.name })} />
                ))}
                {!list.length && <PreviewStatus name={c.name} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </div>
            </section>
          );
        })}

        {!channels.length && (listState.loading
          ? <div className="flex justify-center py-10"><div className="w-8 h-8 spinner" /></div>
          : <Empty icon={<IGrid size={26} />} title={listState.error ? "加载失败" : "暂无分类"} sub={listState.error || "媒体库里还没有内容"} action="重试" onAction={() => void loadChannels()} />)}

        <div className="px-4 text-center text-[10.5px] text-dim pt-1">— 已展示全部分类 —</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div className="h-[150px] flex flex-col justify-center items-start gap-2 text-[11.5px] text-dim px-1">
    <span>{loading ? "加载中…" : error || "暂无内容"}</span>
    {!loading && error && <button aria-label={`重试${name}`} onClick={onRetry} className="text-primary pressable">重试</button>}
  </div>;
}

/* ================= 频道详情页 ================= */
export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<"最新" | "最热" | "高分">("最新");
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.category(cate, next, 20);
      setPageItems((prev) => {
        const seen = new Set(prev.flat().map((x) => x.id));
        return [...prev, (res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message || "加载失败");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  // 每个服务端分页内部排序，分页之间保持追加顺序：
  // 翻页时新一页不会因为 id/hot/score 更高而插到已看内容上方，避免“加载更多像刷新”。
  const sorted = pageItems.flatMap((list) => [...list].sort((a, b) => {
    if (sort === "最热") return (b.hot || 0) - (a.hot || 0);
    if (sort === "高分") return (b.score || 0) - (a.score || 0);
    return b.id - a.id;
  }));

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="w-[40px] h-[40px] rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IGrid size={21} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-bold text-on leading-tight">{name}</div>
            <div className="text-[10.5px] text-mut">共 {items.length} 部 · 已加载 {page}/{Math.max(pages, 1)} 页</div>
          </div>
          <button onClick={() => setSearching(true)} aria-label="搜索短剧" className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></button>
        </div>
        <div className="px-4 pb-3 flex gap-2">
          {(["最新", "最热", "高分"] as const).map((s) => (
            <button key={s} onClick={() => setSort(s)}
              className={`px-4 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${sort === s ? "tonal text-on-sec" : "bg-s3 text-mut"}`}
              style={sort === s ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{s}</button>
          ))}
        </div>
      </div>
      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {sorted.length ? (
          <Masonry videos={sorted} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: sorted.map((x) => x.id), index: sorted.findIndex((x) => x.id === v.id), title: name })} />
        ) : err ? (
          <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={loadMore} />
        ) : (
          <div className="flex justify-center py-10"><div className="w-8 h-8 spinner" /></div>
        )}
        <div ref={sentinel} className="h-10" />
        {loading && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && page >= pages && sorted.length > 0 && (
          <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: `搜索 · ${name}` })} />}
    </div>
  );
}
