// 首页主播放器 + 片库抽屉 + 播放队列：边看边逛、加入 / 下一个 / 移除 / 清空 / 立即播放、播完自动接队列。
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
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error", optimizeDeps: { entries: ["tests/home-queue.html"] } });
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

  await page.goto(`${origin}tests/home-queue.html`);
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.duration > 50; }, null, { timeout: 20000 });
  const drawer = page.locator('aside[aria-label="片库与队列"]');
  await drawer.waitFor();
  const settle = (ms = 400) => page.waitForTimeout(ms);
  const rows = () => drawer.locator("button[title='立即播放']");
  const titles = async () => (await drawer.locator("div.clamp-2").allInnerTexts()).map((t) => t.trim());
  const curTitle = () => page.evaluate(() => (window).__plays.slice(-1)[0]);
  const queueTab = () => drawer.getByRole("button", { name: /^队列/ });

  // 1) 一打开：播放器在播，抽屉展开显示片库
  assert.equal(await rows().count(), 6, "片库默认显示全部 6 部");
  // 分类筛选
  await drawer.getByRole("tab", { name: "类甲" }).click(); await settle();
  assert.deepEqual((await titles()).sort(), ["Film 201", "Film 202"]);
  await drawer.getByRole("tab", { name: "全部" }).click(); await settle();
  // 搜索
  await drawer.getByPlaceholder("搜索片名").fill("204"); await page.waitForFunction(() => document.querySelectorAll("aside div.clamp-2").length === 1);
  assert.deepEqual(await titles(), ["Film 204"]);
  await drawer.getByPlaceholder("搜索片名").fill(""); await settle();

  // 首页第一页是随机顺序，当前在播哪部不固定：挑四部“不是当前这部”的来测（当前这部本来就不会进队列）
  const nowId = await curTitle();
  const [A, B, C, D] = [201, 202, 203, 204, 205, 206].filter((n) => n !== nowId);

  // 2) 加入队列：Film 203 到队尾，Film 205 设为下一个
  const addEnd = (n) => drawer.locator("div.group", { hasText: `Film ${n}` }).getByRole("button", { name: /加入队列|已在队列/ });
  const addNext = (n) => drawer.locator("div.group", { hasText: `Film ${n}` }).getByRole("button", { name: "下一个播放" });
  await addEnd(A).click(); await addNext(B).click(); await settle(200);
  assert.match(await queueTab().innerText(), /队列 · 2/);
  await queueTab().click(); await settle(200);
  assert.deepEqual(await titles(), [`Film ${B}`, `Film ${A}`], "下一个排最前，加入排队尾");

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  // 3) 移到最前 / 移除 / 清空
  await drawer.locator("div.bg-white\\/5", { hasText: `Film ${A}` }).getByRole("button", { name: "移到最前" }).click(); await settle(150);
  assert.deepEqual(await titles(), [`Film ${A}`, `Film ${B}`]);
  await drawer.locator("div.bg-white\\/5", { hasText: `Film ${B}` }).getByRole("button", { name: "从队列移除" }).click(); await settle(150);
  assert.deepEqual(await titles(), [`Film ${A}`]);
  await drawer.getByRole("button", { name: /清空/ }).click(); await settle(150);
  assert.deepEqual(await titles(), []);
  assert.match(await drawer.innerText(), /队列是空的/);

  // 4) 立即播放：点片库里的一部，主播放器跳到它，队列里不留它
  await drawer.getByRole("button", { name: "片库" }).click(); await settle(200);
  await drawer.locator("div.group", { hasText: `Film ${C}` }).locator("button[title='立即播放']").click();
  // 轮到它（成了当前视频）后才会从队列里消掉；__plays 里还会有预取的邻居，不能用来判断当前
  const queueEmpty = (ms) => page.waitForFunction(() => /^队列\s*$/.test([...document.querySelectorAll("aside button")].find((b) => /^队列/.test(b.textContent))?.textContent || ""), null, { timeout: ms });
  await queueEmpty(8000);
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2; }, null, { timeout: 8000 });

  // 5) 播完自动接队列：放一个 Film 202 在队列里，把视频拖到结尾
  await addEnd(D).click(); await settle(200);
  await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; v.currentTime = v.duration - 0.4; return v.play(); });
  assert.match(await queueTab().innerText(), /队列 · 1/, "刚加入的 D 在队列里等着");
  await queueEmpty(12000); // 播完后自动切到 D，D 成为当前视频、从队列消掉
  await page.waitForFunction((n) => window.__plays.includes(n), D, { timeout: 5000 });

  // 6) 收起 / 展开：按钮、Q、拖动（滑入 / 滑出）
  const hidden = (want) => page.waitForFunction((w) => (document.querySelector('aside[aria-label="片库与队列"]').getAttribute("aria-hidden") === "true") === w, want, { timeout: 4000 });
  const edge = () => page.evaluate(() => Math.round(document.querySelector('aside[aria-label="片库与队列"]').getBoundingClientRect().left));
  await drawer.getByRole("button", { name: "收起" }).click(); await hidden(true); await settle(450);
  assert.ok(await edge() >= 1190, `收起后整块滑出画面：left=${await edge()}`);
  assert.ok(await page.getByRole("button", { name: "片库与队列" }).isVisible());
  await page.keyboard.press("q"); await hidden(false); await settle(450);
  assert.ok(await edge() <= 822, `Q 展开后滑入：left=${await edge()}`);
  await page.keyboard.press("q"); await hidden(true); await settle(450);
  // 向左拖右缘的把手拉出来
  const grip = await page.getByRole("button", { name: "拉出片库" }).boundingBox();
  await page.mouse.move(grip.x + 8, grip.y + 30); await page.mouse.down();
  await page.mouse.move(grip.x - 120, grip.y + 30, { steps: 6 });
  assert.ok(await edge() < 1100, "拖动中抽屉跟手滑出来");
  await page.mouse.move(grip.x - 300, grip.y + 30, { steps: 6 }); await page.waitForTimeout(250); await page.mouse.up();
  await hidden(false); await settle(450);
  assert.ok(await edge() <= 822, "拖过一半松手：展开");
  // 向右拖标签栏的空白处收回去
  const head = await drawer.getByRole("button", { name: "片库" }).boundingBox();
  await page.mouse.move(head.x + 200, head.y + 16); await page.mouse.down();
  await page.mouse.move(head.x + 440, head.y + 16, { steps: 6 }); await page.waitForTimeout(250); await page.mouse.up();
  await hidden(true); await settle(450);
  assert.ok(await edge() >= 1190, "向右拖过一半松手：收起");
  // 拖一点点再放回去：弹回原位
  await page.getByRole("button", { name: "片库与队列" }).click(); await hidden(false); await settle(450);
  const head2 = await drawer.getByRole("button", { name: "片库" }).boundingBox();
  await page.mouse.move(head2.x + 200, head2.y + 16); await page.mouse.down();
  await page.mouse.move(head2.x + 240, head2.y + 16, { steps: 4 }); await page.waitForTimeout(700); await page.mouse.up();
  await settle(450);
  assert.ok(await edge() <= 822, "只拖了一点点：弹回展开状态");

  assert.deepEqual(pageErrors, [], `页面不应抛错：${pageErrors.join(" | ")}`);
  console.log("home-queue: all checks passed");
} finally {
  await browser?.close();
  await vite?.close();
  await rm(tmp, { recursive: true, force: true });
}
