/** 侧栏三种状态：展开 → 图标条 → 完全隐藏 → 展开（标题栏按钮循环切换；Cmd/Ctrl+B 在“隐藏 / 恢复”之间切） */
export type RailMode = "full" | "compact" | "hidden";
export const nextRailMode = (m: RailMode): RailMode => (m === "full" ? "compact" : m === "compact" ? "hidden" : "full");
/** Cmd/Ctrl+B：隐藏中就恢复到隐藏前的样子，否则记下当前样子再隐藏。返回 [新状态, 要记住的“隐藏前状态”] */
export const toggleHidden = (m: RailMode, lastShown: RailMode): [RailMode, RailMode] =>
  m === "hidden" ? [lastShown, lastShown] : ["hidden", m];
export const parseRailMode = (v: string | null | undefined): RailMode => (v === "compact" || v === "hidden" ? v : "full");
