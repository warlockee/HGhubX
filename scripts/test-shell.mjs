// 桌面外壳的纯逻辑测试：侧栏三态切换、Cmd/Ctrl+B 隐藏 / 恢复、持久化值解析。
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRailMode, parseRailMode, toggleHidden } from "../src/railMode.ts";

test("标题栏按钮循环：展开 → 图标条 → 隐藏 → 展开", () => {
  assert.equal(nextRailMode("full"), "compact");
  assert.equal(nextRailMode("compact"), "hidden");
  assert.equal(nextRailMode("hidden"), "full");
});

test("Cmd/Ctrl+B：隐藏中恢复到隐藏前的样子，否则记下当前样子再隐藏", () => {
  assert.deepEqual(toggleHidden("full", "full"), ["hidden", "full"]);
  assert.deepEqual(toggleHidden("hidden", "full"), ["full", "full"]);
  assert.deepEqual(toggleHidden("compact", "full"), ["hidden", "compact"]); // 图标条状态下隐藏，恢复时回到图标条
  assert.deepEqual(toggleHidden("hidden", "compact"), ["compact", "compact"]);
});

test("持久化值：只认 compact / hidden，其它（含空、被改坏）一律当展开", () => {
  assert.equal(parseRailMode("compact"), "compact");
  assert.equal(parseRailMode("hidden"), "hidden");
  assert.equal(parseRailMode("full"), "full");
  for (const bad of [null, undefined, "", "xx", "HIDDEN"]) assert.equal(parseRailMode(bad), "full");
});
