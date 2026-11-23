import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "./Feed";
import { api } from "../api";
import { libraryApi } from "../library";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { IList, ISearch } from "../icons";
import { Empty } from "../components/ui";
import BrowseDrawer from "../components/BrowseDrawer";
import { composeList } from "../queue";

/* Fisher-Yates 洗牌：首页第一页随机打乱，避免每次进来都停在同一个 top1 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Home({ active, bottomInset, wide = true }: { active: boolean; bottomInset: number; wide?: boolean }) {
  const { toast, lineEpoch, libraryEpoch, gate, queue, dequeue, jump, browse, setBrowse } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  /* 翻页失败退避：失败后 5 秒内不再因滚动触发重试，连续失败只提示一次 */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async (p: number): Promise<void> => {
    if (loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    let retryAfterLineChange = false;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.feed(p, 30);
      const list = res?.items || [];
      const ordered = p === 1 ? shuffle(list) : list;
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...ordered.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      failStreak.current = 0;
      retryAt.current = 0;
      if (!list.length || (res?.pagination && p >= res.pagination.pages)) setDone(true);
    } catch (e) {
      const message = (e as Error).message || "加载失败";
      const stale = requestEpoch !== lineEpochRef.current;
      if (!stale) {
        setError(message);
        if (p > 1) retryAt.current = Date.now() + 5000;
        if (failStreak.current++ === 0) toast(message, "info");
      }
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale && !itemsRef.current.length) retryAfterLineChange = true;
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (retryAfterLineChange) {
        setDone(false);
        setError("");
        void load(1);
      }
    }
  }, [done, toast]);

  useEffect(() => { if (!items.length) load(1); /* eslint-disable-next-line */ }, []);

  /* 线路切换后：首页还没拿到数据（加载失败或空）就在新线路上重拉一次。
     已有数据时不动，避免打断正在播放的视频。 */
  useEffect(() => {
    if (!lineEpoch || items.length || loadingRef.current) return;
    setDone(false);
    setError("");
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineEpoch]);

  /* 片库有增删：剔除已经不存在的视频、把新增的补到末尾。
     只追加 / 剔除，不重排也不重置，Feed 会按 id 找回当前视频，不打断正在播放的内容。 */
  useEffect(() => {
    if (!libraryEpoch || !itemsRef.current.length || !gate.base) return;
    let alive = true;
    (async () => {
      try {
        const [{ ids: live }, fresh] = await Promise.all([libraryApi.ids(gate.base), api.feed(1, 30)]);
        if (!alive) return;
        const exist = new Set(live);
        setItems((prev) => {
          const kept = prev.filter((v) => exist.has(v.id));
          const seen = new Set(kept.map((v) => v.id));
          const added = (fresh?.items || []).filter((v) => exist.has(v.id) && !seen.has(v.id));
          return kept.length === prev.length && !added.length ? prev : [...kept, ...added];
        });
      } catch { /* 暂时取不到就等下一次 */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryEpoch]);

  /* 喂给播放器的列表 = 已看过的 + 播放队列 + 其余。队列增删时列表跟着变，播放器按 id 找回当前视频不跳。 */
  const [cur, setCur] = useState<number | undefined>(undefined);
  const shownRef = useRef<number[]>([]);
  const ids = useMemo(() => {
    const next = composeList(shownRef.current, cur, queue.map((x) => x.id), items.map((v) => v.id));
    shownRef.current = next;
    return next;
  }, [items, queue, cur]);
  /* 轮到队列里的那一条（或用户直接翻到它）就把它从队列里消掉 */
  const onCurrent = useCallback((id: number) => setCur(id), []);
  useEffect(() => { if (cur != null && queue.some((x) => x.id === cur)) dequeue(cur); }, [cur, queue, dequeue]);

  /* Q：展开 / 收起片库抽屉（输入框里打字时不触发） */
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "q") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || (t.tagName === "INPUT" && !["range", "checkbox", "button"].includes((t as HTMLInputElement).type)) || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
      setBrowse({ open: !browse.open });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, browse.open, setBrowse]);

  return (
    <div className="absolute inset-0 bg-black overflow-hidden">
      {items.length ? (
        /* 桌面宽屏：抽屉展开时把播放区让出来（不盖住画面）；窄屏抽屉是盖在上面的 */
        <div className="absolute top-0 bottom-0 left-0" style={{ right: wide && browse.open ? 380 : 0 }}>
          <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset} onCurrent={onCurrent} jumpTo={jump}
            onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) load(page + 1); }} />
        </div>
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      )}
      {!browse.open && (
        <button onClick={() => setBrowse({ open: true })} title="片库与队列 (Q)" aria-label="片库与队列"
          className="absolute z-20 right-3 flex items-center gap-1.5 px-3 h-9 rounded-full bg-black/55 backdrop-blur text-white text-[12.5px] font-semibold pressable hover:bg-black/70"
          style={{ top: "calc(var(--sat, 0px) + 12px)" }}>
          <IList size={15} />片库{queue.length > 0 && <span className="px-1.5 rounded-full bg-white text-black text-[11px]">{queue.length}</span>}
        </button>
      )}
      <BrowseDrawer wide={wide} />
    </div>
  );
}
