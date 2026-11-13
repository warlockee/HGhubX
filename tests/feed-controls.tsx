import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Feed from "../src/pages/Feed";
import { AppProvider } from "../src/store";
import "../src/index.css";

// Tauri IPC 全部 mock；播放器、键盘 / 滚轮处理都是真实实现。媒体由测试脚本经 hg.localhost 路由提供。
const detail = (id: number) => ({
  video: {
    id, title: `Video ${id}`, description: "", cover: "", tags: [] as string[], score: 0,
    episode_count: 1, total_episodes: 1, episodes: [{ ep_num: 1, title: "1", duration: 60, status: 1 }],
    counts: { collect: 0, comment: 0, hot: 0, like: 0 }, author: { id: 1, name: "NAS" }, is_finished: true, is_original: 0,
  },
});
const empty = { items: [], pagination: { page: 1, pages: 0, size: 20, total: 0 } };

Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "gate_state") return Promise.resolve({ base: "http://fixture.invalid/", adapter: "edge_v1", activated: true });
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "http://fixture.invalid/" });
      if (cmd === "debug_log") return Promise.resolve();
      if (cmd === "data_call") {
        const c = (args.command || {}) as Record<string, unknown>;
        switch (c.cmd) {
          case "video": return Promise.resolve(detail(Number(c.id)).video);
          case "play": return Promise.resolve({ id: c.id, ep_num: 1, duration: 60, title: "t", video_url: "http://fixture.invalid/clip.mp4", streams: { main: "http://fixture.invalid/clip.mp4" } });
          case "related": return Promise.resolve({ items: [] });
          case "comments": return Promise.resolve({ ep: 1, ...empty });
          default: return Promise.resolve(empty);
        }
      }
      return Promise.reject(`Unexpected IPC: ${cmd}`);
    },
  },
});

/** 测试可以从外部换掉列表（模拟片库刷新：剔除已删除的、追加新增的） */
function Host() {
  const [ids, setIds] = useState([101, 102, 103]);
  (window as unknown as { __setIds: (v: number[]) => void }).__setIds = setIds;
  return (
    <div style={{ position: "relative", width: 1200, height: 780 }}>
      <Feed videoIds={ids} mode="context" active bottomInset={0} />
    </div>
  );
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Host />
  </AppProvider>,
);
