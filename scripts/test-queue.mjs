// 播放队列纯逻辑测试。Node 24 直接 import .ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeList, dequeue, enqueue, promote } from "../src/queue.ts";

const it = (id) => ({ id, title: `t${id}`, cover: "" });

test("入队 / 插队 / 去重 / 删除 / 置顶", () => {
  let q = [];
  q = enqueue(q, it(1)); q = enqueue(q, it(2)); q = enqueue(q, it(3));
  assert.deepEqual(q.map((x) => x.id), [1, 2, 3]);
  q = enqueue(q, it(2)); // 已在队列：挪到末尾，不重复
  assert.deepEqual(q.map((x) => x.id), [1, 3, 2]);
  q = enqueue(q, it(3), true); // 下一个播
  assert.deepEqual(q.map((x) => x.id), [3, 1, 2]);
  assert.deepEqual(dequeue(q, 1).map((x) => x.id), [3, 2]);
  assert.deepEqual(dequeue(q, 99).map((x) => x.id), [3, 1, 2]);
  assert.deepEqual(promote(q, 2).map((x) => x.id), [2, 3, 1]);
  assert.deepEqual(promote(q, 99).map((x) => x.id), [3, 1, 2]);
});

test("合成列表：看过的保持、队列紧跟当前、其余按原顺序", () => {
  const base = [10, 11, 12, 13, 14];
  // 正在播 11，队列 [13, 99]：10 11 | 13 99 | 12 14
  assert.deepEqual(composeList(base, 11, [13, 99], base), [10, 11, 13, 99, 12, 14]);
  // 没有队列：原样
  assert.deepEqual(composeList(base, 11, [], base), base);
  // 队列清空后，原来排在前面的不会丢，已看过的也还在
  const prev = composeList(base, 11, [13, 99], base);
  assert.deepEqual(composeList(prev, 11, [], base), [10, 11, 12, 13, 14]);
});

test("播到队列里的视频后：它成了“已看过”，队列剩下的继续排在后面", () => {
  const base = [10, 11, 12, 13];
  const prev = composeList(base, 10, [13, 99], base); // 10 13 99 11 12
  assert.deepEqual(prev, [10, 13, 99, 11, 12]);
  // 切到 13（队列里的），store 把 13 从队列里去掉
  assert.deepEqual(composeList(prev, 13, [99], base), [10, 13, 99, 11, 12]);
  // 即使队列里还留着 13，也不会重复出现
  assert.deepEqual(composeList(prev, 13, [13, 99], base), [10, 13, 99, 11, 12]);
});

test("点播（立即播放）= 插到队首，当前位置之后马上就是它", () => {
  const base = [10, 11, 12, 13];
  const q = enqueue([it(13)], it(50), true).map((x) => x.id); // [50, 13]
  assert.deepEqual(composeList(base, 11, q, base), [10, 11, 50, 13, 12]);
  // 当前视频不在列表里的异常情况：只保留它自己
  assert.deepEqual(composeList([10, 11], 77, [], base), [77, 10, 11, 12, 13]);
});

test("没有当前视频（刚加载）：队列在前，其余在后；队列重复项去重", () => {
  assert.deepEqual(composeList([], undefined, [3, 3, 1], [1, 2, 3]), [3, 1, 2]);
});
