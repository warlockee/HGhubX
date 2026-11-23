import { createRoot } from "react-dom/client";
import Home from "../src/pages/Home";
import { AppProvider } from "../src/store";
import "../src/index.css";

// 首页主播放器 + 片库抽屉 + 播放队列。Tauri IPC 被 mock；播放器、队列、抽屉都是真实实现。
const card = (id: number, tags: string[] = ["A"]) => ({
  id, title: `Film ${id}`, cover: "", description: "", tags, score: 0, episode_count: 1, total_episodes: 1, hot: 0, like_count: 0, collect_count: 0, is_finished: true,
});
const ALL = [201, 202, 203, 204, 205, 206];
const detail = (id: number) => ({
  id, title: `Film ${id}`, description: "", cover: "", tags: [] as string[], score: 0,
  episode_count: 1, total_episodes: 1, episodes: [{ ep_num: 1, title: "1", duration: 60, status: 1 }],
  counts: { collect: 0, comment: 0, hot: 0, like: 0 }, author: { id: 1, name: "NAS" }, is_finished: true, is_original: 0,
});
const page = (ids: number[]) => ({ items: ids.map((i) => card(i)), pagination: { page: 1, pages: 1, size: 30, total: ids.length } });
const empty = { items: [], pagination: { page: 1, pages: 0, size: 20, total: 0 } };
const w = window as unknown as { __plays: number[] };
w.__plays = [];

Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => 1,
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "gate_state") return Promise.resolve({ base: "http://fixture.invalid/", adapter: "edge_v1", activated: true });
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "http://fixture.invalid/" });
      if (cmd === "debug_log" || cmd === "plugin:event|listen") return Promise.resolve(cmd === "debug_log" ? undefined : 1);
      if (cmd === "data_call") {
        const c = (args.command || {}) as Record<string, unknown>;
        switch (c.cmd) {
          case "feed": return Promise.resolve(page(ALL));
          case "tags": return Promise.resolve({ categories: [{ name: "分类", tags: [{ id: 1, name: "类甲", slug: "cat-a" }, { id: 2, name: "类乙", slug: "cat-b" }] }] });
          case "category": return Promise.resolve(c.cate === "cat-a" ? page([201, 202]) : page([205, 206]));
          case "search": return Promise.resolve(String(c.q).includes("204") ? page([204]) : { ...empty });
          case "video": return Promise.resolve(detail(Number(c.id)));
          case "play": w.__plays.push(Number(c.id)); return Promise.resolve({ id: c.id, ep_num: 1, duration: 60, title: "t", video_url: "http://fixture.invalid/clip.mp4", streams: { main: "http://fixture.invalid/clip.mp4" } });
          case "related": return Promise.resolve({ items: [] });
          case "comments": return Promise.resolve({ ep: 1, ...empty });
          default: return Promise.resolve(empty);
        }
      }
      return Promise.reject(`Unexpected IPC: ${cmd}`);
    },
  },
});

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <div style={{ position: "relative", width: 1200, height: 780 }}>
      <Home active bottomInset={0} wide />
    </div>
  </AppProvider>,
);
