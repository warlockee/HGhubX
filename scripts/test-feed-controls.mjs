// Feed 键盘 / 触控板控制回归：←→ 进度、↑↓ 音量、PageUp/PageDown 切视频，双指横滑 = 进度、纵滑 = 音量。
// 本地浏览器 fixture，Tauri IPC 被 mock；需要 ffmpeg 生成测试视频、本机有 Chrome（或 BROWSER_EXECUTABLE）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.BROWSER_EXECUTABLE || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const tmp = await mkdtemp(join(tmpdir(), "hghubx-feed-"));
const clip = join(tmp, "clip.mp4");
// 60 秒、每秒一个关键帧，seek 精确
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=60:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=duration=60",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-movflags", "+faststart", clip]);
const media = await readFile(clip);

let vite, browser;
const pageErrors = [];
try {
  // 预先声明入口：否则 Vite 首次运行会在测试中途发现新依赖、重载页面，导致偶发失败
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error", optimizeDeps: { entries: ["tests/feed-controls.html"] } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  // Windows UA：媒体基址是 http://hg.localhost，可被 page.route 接管（macOS UA 用的 hg:// 自定义协议浏览器接管不了）
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 780 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    if (url.hostname === "hg.localhost" && url.pathname === "/seg") {
      const m = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), media.length - 1) : media.length - 1;
      return route.fulfill({
        status: m ? 206 : 200, body: media.subarray(start, end + 1),
        headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*",
          ...(m ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}) },
      });
    }
    return route.abort();
  });

  await page.goto(`${origin}tests/feed-controls.html`);
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.duration > 50; }, null, { timeout: 20000 });

  const vs = () => page.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, vol: v.volume, muted: v.muted }; });
  const scrollTop = () => page.evaluate(() => document.querySelector(".snap-y").scrollTop);
  const osd = () => page.locator('[role="status"]').last().innerText().catch(() => "");
  const settle = (ms = 450) => page.waitForTimeout(ms);
  const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ≈${b}`);

  await page.evaluate(() => { const v = document.querySelector("video"); v.pause(); v.currentTime = 20; });
  await page.waitForFunction(() => !document.querySelector("video").seeking);
  await page.mouse.move(600, 400);

  // ── 键盘：← → 进度 ──
  await page.keyboard.press("ArrowRight"); await settle();
  near((await vs()).t, 25, 0.8, "→ 快进 5 秒");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await settle(600); // 连按：必须在待生效目标上累加
  near((await vs()).t, 35, 1, "连按两次 → 累计 +10 秒");
  await page.keyboard.press("Shift+ArrowLeft"); await settle();
  near((await vs()).t, 20, 1, "Shift+← 快退 15 秒");
  await page.keyboard.press("ArrowLeft"); await settle();
  near((await vs()).t, 15, 0.8, "← 快退 5 秒");
  assert.match(await osd(), /\d+:\d{2} \/ 1:00/, "进度提示（OSD）应显示 当前/总时长");

  // ── 键盘：↑ ↓ 音量 ──
  let s = await vs();
  assert.ok(s.muted, "默认启动静音");
  near(s.vol, 0.7, 0.001, "初始音量");
  await page.keyboard.press("ArrowDown"); await settle(100);
  s = await vs();
  assert.ok(s.muted, "静音时按 ↓ 不应悄悄取消静音");
  near(s.vol, 0.7, 0.001, "静音时 ↓ 不改音量");
  await page.keyboard.press("ArrowUp"); await settle(150);
  s = await vs();
  assert.ok(!s.muted, "↑ 调大会解除静音");
  near(s.vol, 0.75, 0.001, "↑ +5%");
  await page.keyboard.press("ArrowDown"); await settle(150);
  near((await vs()).vol, 0.7, 0.001, "↓ −5%");
  await page.keyboard.press("Shift+ArrowUp"); await settle(150);
  near((await vs()).vol, 0.71, 0.001, "Shift+↑ +1%");
  assert.match(await osd(), /音量 71%/, "音量提示（OSD）");
  assert.equal(await scrollTop(), 0, "↑↓ 不再切换视频");

  // ── 切视频改为 PageDown / PageUp ──
  await page.keyboard.press("PageDown");
  await page.waitForFunction(() => document.querySelector(".snap-y").scrollTop > 700, null, { timeout: 5000 });
  await page.keyboard.press("PageUp");
  await page.waitForFunction(() => document.querySelector(".snap-y").scrollTop < 5, null, { timeout: 5000 });
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2; });

  // ── 触控板（wheel）：横向 = 进度，纵向 = 音量，且不再滚动切视频 ──
  await page.evaluate(() => { const v = document.querySelector("video"); v.pause(); v.currentTime = 10; });
  await page.waitForFunction(() => !document.querySelector("video").seeking);
  await page.mouse.move(600, 400);
  await page.mouse.wheel(200, 0); await settle(600);          // 200px × 0.15 = +30 秒
  near((await vs()).t, 40, 2, "横向滑动 = 快进");
  await page.mouse.wheel(-100, 0); await settle(600);         // −15 秒
  near((await vs()).t, 25, 2, "反向横滑 = 快退");
  const volBefore = (await vs()).vol;
  await page.mouse.wheel(0, -40); await settle(300);          // 向上 40px × 0.0025 = +0.10
  near((await vs()).vol, Math.min(1, volBefore + 0.1), 0.011, "纵向上滑 = 音量加");
  await page.waitForTimeout(300);                              // 间隔超过手势阈值，重新判定方向
  await page.mouse.wheel(0, 80); await settle(300);           // 向下 80px = −0.20
  near((await vs()).vol, Math.min(1, volBefore + 0.1) - 0.2, 0.011, "纵向下滑 = 音量减");
  assert.equal(await scrollTop(), 0, "纵向滚轮不再切换视频");
  assert.match(await osd(), /音量 \d+%|静音/, "滚轮音量提示（OSD）");

  assert.deepEqual(pageErrors, [], "页面不应有未捕获异常");
  console.log("feed-controls: all checks passed");
} finally {
  await browser?.close();
  await vite?.close();
  await rm(tmp, { recursive: true, force: true });
}
