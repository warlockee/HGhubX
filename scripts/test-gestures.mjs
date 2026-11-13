// 触控板 / 滚轮手势换算的单元测试（纯逻辑，不需要浏览器）。Node 24 自带类型剥离，直接 import .ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWheelTracker, GESTURE_GAP_MS, SEEK_STEP_PX, SEEK_STEP_SEC, VOLUME_PER_PX } from "../src/player/gestures.ts";

const ev = (deltaX, deltaY, extra = {}) => ({ deltaX, deltaY, deltaMode: 0, ...extra });

test("横向手势 = 进度，离散步长：每滑过 SEEK_STEP_PX 就是 ±SEEK_STEP_SEC 秒（和 ←→ 键一样）", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(SEEK_STEP_PX / 2, 3), 0), null); // 没凑够一步不动
  assert.deepEqual(t(ev(SEEK_STEP_PX / 2, 1), 10), { kind: "seek", seconds: SEEK_STEP_SEC }); // 凑够了：非自然滚动 deltaX 为正 = 快进
  assert.equal(t(ev(SEEK_STEP_PX / 2, 0), 20), null); // 余量继续累计，不丢也不重复
  // 往回划 2 步的距离：先抵掉余下的半步，净值 −1.5 步 → 只算整数部分 −1 步，剩下半步留着
  assert.deepEqual(t(ev(-SEEK_STEP_PX * 2, 1), 30), { kind: "seek", seconds: -SEEK_STEP_SEC });
});

test("新手势清掉没凑够一步的余量", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(SEEK_STEP_PX * 0.9, 0), 0), null);
  assert.equal(t(ev(SEEK_STEP_PX * 0.9, 0), GESTURE_GAP_MS + 1), null); // 不会和上一次手势的余量加到一起
});

test("自然滚动（webkitDirectionInvertedFromDevice）下按手指方向：手指向右 = 快进", () => {
  const t = createWheelTracker();
  // 自然滚动：手指向右 → deltaX 为负
  const a = t(ev(-SEEK_STEP_PX, 0, { webkitDirectionInvertedFromDevice: true }), 0);
  assert.deepEqual(a, { kind: "seek", seconds: SEEK_STEP_SEC });
  const b = t(ev(SEEK_STEP_PX, 0, { webkitDirectionInvertedFromDevice: true }), 5);
  assert.deepEqual(b, { kind: "seek", seconds: -SEEK_STEP_SEC });
});

test("纵向手势 = 音量；手指 / 滚轮向上 = 调大", () => {
  const plain = createWheelTracker();
  assert.deepEqual(plain(ev(0, -100), 0), { kind: "volume", delta: 100 * VOLUME_PER_PX }); // 滚轮向上 deltaY<0
  assert.ok(plain(ev(0, 100), 5).delta < 0);
  const natural = createWheelTracker();
  assert.ok(natural(ev(0, 100, { webkitDirectionInvertedFromDevice: true }), 0).delta > 0); // 自然滚动：手指向上 deltaY>0
  assert.ok(natural(ev(0, -100, { webkitDirectionInvertedFromDevice: true }), 5).delta < 0);
});

test("一次手势里方向锁定：斜着划不会又调进度又调音量", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(SEEK_STEP_PX, 5), 0).kind, "seek");
  // 后面哪怕纵向分量变大，只要还在同一手势里（含惯性），仍按进度处理（不会变成音量）
  assert.notEqual(t(ev(2, 40), 16)?.kind, "volume");
  assert.notEqual(t(ev(1, 30), 32)?.kind, "volume");
});

test("间隔超过阈值视为新手势，重新判定方向", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(SEEK_STEP_PX, 0), 0).kind, "seek");
  assert.equal(t(ev(0, 30), GESTURE_GAP_MS + 1).kind, "volume");
});

test("微小抖动被忽略；行 / 页单位换算成像素", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(0.5, 0.5), 0), null);
  const lines = createWheelTracker();
  assert.deepEqual(lines({ deltaX: 0, deltaY: -1, deltaMode: 1 }, 0), { kind: "volume", delta: 16 * VOLUME_PER_PX });
});

test("量级合理：约 400px 调满音量；一步 80px = 5 秒", () => {
  assert.ok(Math.abs(400 * VOLUME_PER_PX - 1) < 1e-9);
  assert.equal(SEEK_STEP_SEC, 5); // 与 ←→ 键的步长一致
});
