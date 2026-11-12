/** 触控板双指 / 鼠标滚轮 → 播放器动作的换算（纯函数，便于测试）。
 *
 *  横向 = 进度，纵向 = 音量；一次手势里方向锁定，不会斜着划时又调进度又调音量。
 *  以「手指 / 滚轮的物理方向」为准，与系统「自然滚动」设置无关：
 *  WebKit 会在滚轮事件上带 webkitDirectionInvertedFromDevice 告诉我们是否反向，据此还原。 */

/** 手指横向每移动 1px 对应的秒数（约 7px 一秒） */
export const SEEK_SEC_PER_PX = 0.15;
/** 手指纵向每移动 1px 对应的音量（约 400px 满量程） */
export const VOLUME_PER_PX = 0.0025;
/** 两次滚轮事件间隔超过它就视为新的一次手势（惯性滚动的事件间隔远小于此） */
export const GESTURE_GAP_MS = 220;

export type WheelLike = {
  deltaX: number;
  deltaY: number;
  deltaMode: number; // 0 像素 / 1 行 / 2 页
  webkitDirectionInvertedFromDevice?: boolean;
};

export type WheelAction =
  | { kind: "seek"; seconds: number }   // 正 = 快进
  | { kind: "volume"; delta: number }   // 正 = 调大
  | null;

export function createWheelTracker() {
  let axis: "" | "x" | "y" = "";
  let last = -Infinity;
  return (e: WheelLike, now: number): WheelAction => {
    if (now - last > GESTURE_GAP_MS) axis = ""; // 新的一次手势，重新判定方向
    last = now;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (!axis) {
      if (Math.abs(dx) + Math.abs(dy) < 2) return null; // 抖动
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    const inverted = e.webkitDirectionInvertedFromDevice === true;
    if (axis === "x") {
      // 手指向右 = 快进（自然滚动下手指向右时 deltaX 为负）
      return { kind: "seek", seconds: (inverted ? -dx : dx) * SEEK_SEC_PER_PX };
    }
    // 手指 / 滚轮向上 = 音量加（自然滚动下手指向上时 deltaY 为正）
    return { kind: "volume", delta: (inverted ? dy : -dy) * VOLUME_PER_PX };
  };
}
