// 触控板 / 滚轮手势换算的单元测试（纯逻辑，不需要浏览器）。Node 24 自带类型剥离，直接 import .ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWheelTracker, GESTURE_GAP_MS, SEEK_SEC_PER_PX, VOLUME_PER_PX } from "../src/player/gestures.ts";

const ev = (deltaX, deltaY, extra = {}) => ({ deltaX, deltaY, deltaMode: 0, ...extra });

test("横向手势 = 进度；非自然滚动时 deltaX 为正 = 快进", () => {
  const t = createWheelTracker();
  assert.deepEqual(t(ev(40, 3), 0), { kind: "seek", seconds: 40 * SEEK_SEC_PER_PX });
  assert.deepEqual(t(ev(-20, 1), 10), { kind: "seek", seconds: -20 * SEEK_SEC_PER_PX });
});

test("自然滚动（webkitDirectionInvertedFromDevice）下按手指方向：手指向右 = 快进", () => {
  const t = createWheelTracker();
  // 自然滚动：手指向右 → deltaX 为负
  const a = t(ev(-40, 0, { webkitDirectionInvertedFromDevice: true }), 0);
  assert.equal(a.kind, "seek");
  assert.ok(a.seconds > 0);
  const b = t(ev(40, 0, { webkitDirectionInvertedFromDevice: true }), 5);
  assert.ok(b.seconds < 0);
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
  assert.equal(t(ev(30, 5), 0).kind, "seek");
  // 后面哪怕纵向分量变大，只要还在同一手势里（含惯性），仍按进度处理
  assert.equal(t(ev(2, 40), 16).kind, "seek");
  assert.equal(t(ev(1, 30), 32).kind, "seek");
});

test("间隔超过阈值视为新手势，重新判定方向", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(30, 0), 0).kind, "seek");
  assert.equal(t(ev(0, 30), GESTURE_GAP_MS + 1).kind, "volume");
});

test("微小抖动被忽略；行 / 页单位换算成像素", () => {
  const t = createWheelTracker();
  assert.equal(t(ev(0.5, 0.5), 0), null);
  const lines = createWheelTracker();
  assert.deepEqual(lines({ deltaX: 0, deltaY: -1, deltaMode: 1 }, 0), { kind: "volume", delta: 16 * VOLUME_PER_PX });
});

test("满量程手势的量级合理：约 400px 调满音量、约 7px 快进 1 秒", () => {
  assert.ok(Math.abs(400 * VOLUME_PER_PX - 1) < 1e-9);
  assert.ok(Math.abs(7 * SEEK_SEC_PER_PX - 1) < 0.1);
});
