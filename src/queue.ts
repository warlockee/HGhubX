/** 播放队列（“接下来播放”）：一个跨页面共享的有序列表，和首页主播放器配合。
 *  纯函数，便于测试；状态存放在 store 里。 */

export type QueueItem = { id: number; title: string; cover: string };

/** 加入队列。next=true 排到最前（下一个就播），否则排到末尾；已在队列里的先移除再放，避免重复。 */
export function enqueue(q: readonly QueueItem[], item: QueueItem, next = false): QueueItem[] {
  const rest = q.filter((x) => x.id !== item.id);
  return next ? [item, ...rest] : [...rest, item];
}
export const dequeue = (q: readonly QueueItem[], id: number): QueueItem[] => q.filter((x) => x.id !== id);
/** 把队列里的某一项提到最前 */
export function promote(q: readonly QueueItem[], id: number): QueueItem[] {
  const it = q.find((x) => x.id === id);
  return it ? [it, ...q.filter((x) => x.id !== id)] : [...q];
}

/**
 * 合成喂给播放器的列表：已经看过的（含当前）保持原样 → 队列 → 其余原顺序。
 * - prev：上一次喂给播放器的列表（用来保留“已看过”的部分，上划还能回去）
 * - cur：当前正在播的视频 id
 * - queue：待播队列；base：首页 / 分类的原始顺序
 * 当前视频不在 prev 里（正常不会发生：播放器只会停在自己拿到的列表里）时，只保留它自己当“已看过”。
 */
export function composeList(prev: readonly number[], cur: number | undefined, queue: readonly number[], base: readonly number[]): number[] {
  if (cur == null) {
    const q = queue.filter((id, i) => queue.indexOf(id) === i);
    return [...q, ...base.filter((id) => !q.includes(id))];
  }
  const at = prev.indexOf(cur);
  const head = at >= 0 ? prev.slice(0, at + 1) : [cur];
  const inHead = new Set(head);
  const q = queue.filter((id, i) => !inHead.has(id) && queue.indexOf(id) === i);
  const inQ = new Set(q);
  return [...head, ...q, ...base.filter((id) => !inHead.has(id) && !inQ.has(id))];
}
