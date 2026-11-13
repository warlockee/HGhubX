import { useCallback, useEffect, useRef, useState } from "react";
import Feed from "./Feed";
import { api } from "../api";
import { libraryApi } from "../library";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";

/* Fisher-Yates 洗牌：首页第一页随机打乱，避免每次进来都停在同一个 top1 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch, libraryEpoch, gate } = useStore();
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

  const ids = items.map((v) => v.id);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) load(page + 1); }} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
