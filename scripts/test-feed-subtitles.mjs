// Feed 字幕回归：菜单 → 选语言 → 生成进度 → 完成后显示；V 切换模式、[ ] 调整快慢；不支持字幕的数据源不显示入口。
// 浏览器 fixture（复用 tests/feed-controls.html），字幕后端接口由本脚本模拟；需要 ffmpeg 与 Chrome。
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
const tmp = await mkdtemp(join(tmpdir(), "hghubx-sub-"));
const clip = join(tmp, "clip.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=60:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=duration=60",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-movflags", "+faststart", clip]);
const media = await readFile(clip);

const CUES = { version: "v1", language: "ja", translated: true, cues: [
  { s: 1, e: 4, t: "こんにちは。", z: "你好。" },
  { s: 5, e: 8, t: "映画を見ましょう。", z: "我们看电影吧。" },
] };

async function run({ supportsSubtitles }) {
  let vite, browser;
  const calls = [];
  let polls = 0, started = false;
  try {
    vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error", optimizeDeps: { entries: ["tests/feed-controls.html"] } });
    await vite.listen();
    const origin = vite.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true, executablePath: chrome });
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 780 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const json = (route, body, status = 200) => route.fulfill({ status, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      if (url.hostname === "hg.localhost" && url.pathname === "/seg") {
        const target = new URL(url.searchParams.get("u"));
        if (target.pathname.startsWith("/sub/")) {
          calls.push(target.pathname);
          if (!supportsSubtitles) return route.fulfill({ status: 502, body: "no", headers: { "Access-Control-Allow-Origin": "*" } });
          if (target.pathname === "/sub/capabilities") return json(route, { asr: true, vad: true, translate: true, missing: [], note: "" });
          if (target.pathname === "/sub/101/1/status") {
            if (!started) return json(route, { state: "idle" });
            polls += 1;
            return polls < 3 ? json(route, { state: "running", stage: "transcribe", progress: 0.1 + polls * 0.2, message: "正在识别语音…", language: "ja" })
              : json(route, { state: "done", language: "ja", translated: true, version: "v1", count: 2 });
          }
          if (target.pathname === "/sub/101/1/start") { started = true; polls = 0; calls.push(`start?${target.searchParams}`); return json(route, { state: "queued", stage: "queued", progress: 0, message: "排队中…", queued: 1 }); }
          if (target.pathname === "/sub/101/1/cues.json") return json(route, CUES);
          return json(route, { state: "idle" });
        }
        const m = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || "");
        const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), media.length - 1) : media.length - 1;
        return route.fulfill({ status: m ? 206 : 200, body: media.subarray(start, end + 1),
          headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", ...(m ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}) } });
      }
      return route.abort();
    });

    await page.goto(`${origin}tests/feed-controls.html`);
    await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.duration > 50; }, null, { timeout: 20000 });
    await page.evaluate(() => { const v = document.querySelector("video"); v.pause(); v.currentTime = 2; });
    await page.waitForFunction(() => !document.querySelector("video").seeking);
    await page.waitForTimeout(400);
    return { page, calls, errors, ctx, browser, vite };
  } catch (e) { await browser?.close(); await vite?.close(); throw e; }
}

const subtitleText = (page) => page.evaluate(() => {
  const root = document.querySelector('[aria-live="off"]');
  return root ? root.innerText.replace(/\n+/g, "|") : "";
});

let h;
try {
  // ── 数据源不支持字幕：不显示入口，V 键也没反应 ──
  h = await run({ supportsSubtitles: false });
  assert.equal(await h.page.locator('button[aria-label="字幕"]').count(), 0, "不支持字幕的数据源不应显示字幕按钮");
  await h.page.keyboard.press("v"); await h.page.waitForTimeout(200);
  assert.equal(await h.page.locator('[role="dialog"][aria-label="字幕"]').count(), 0);
  await h.browser.close(); await h.vite.close();

  // ── 支持字幕：生成 → 显示 → 切换 ──
  h = await run({ supportsSubtitles: true });
  const { page } = h;
  await page.waitForSelector('button[aria-label="字幕"]', { timeout: 5000 });
  await page.click('button[aria-label="字幕"]');
  const dialog = page.locator('[role="dialog"][aria-label="字幕"]');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /视频里说的是什么语言/, "还没有字幕：显示语言选择");
  await dialog.getByRole("button", { name: "日语" }).click();
  await dialog.getByRole("button", { name: "生成字幕" }).click();
  await page.waitForFunction(() => /识别语音|排队/.test(document.querySelector('[role="dialog"][aria-label="字幕"]')?.innerText || ""), null, { timeout: 5000 });
  assert.ok(h.calls.some((c) => c.startsWith("start?lang=ja")), `应带语言参数启动：${h.calls.join(",")}`);
  // 轮询到完成：菜单变成显示模式选择
  await page.waitForFunction(() => /共 2 条/.test(document.querySelector('[role="dialog"][aria-label="字幕"]')?.innerText || ""), null, { timeout: 15000 });
  assert.match(await dialog.innerText(), /识别语言：日语/);
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  assert.equal(await dialog.count(), 0, "Esc 关闭菜单");

  // 默认双语：中文在上，原文在下
  await page.evaluate(() => { document.querySelector("video").currentTime = 2; });
  await page.waitForFunction(() => document.querySelector('[aria-live="off"]'), null, { timeout: 4000 });
  assert.equal(await subtitleText(page), "你好。|こんにちは。", "双语显示：中文 + 原文");
  // 没有字幕的时刻不显示
  await page.evaluate(() => { document.querySelector("video").currentTime = 10; });
  await page.waitForFunction(() => !document.querySelector('[aria-live="off"]'), null, { timeout: 4000 });
  await page.evaluate(() => { document.querySelector("video").currentTime = 6; });
  await page.waitForFunction(() => document.querySelector('[aria-live="off"]'), null, { timeout: 4000 });
  assert.equal(await subtitleText(page), "我们看电影吧。|映画を見ましょう。");

  // V：双语 → 中文 → 原文 → 关闭
  await page.keyboard.press("v"); await page.waitForTimeout(200);
  assert.equal(await subtitleText(page), "我们看电影吧。", "中文");
  await page.keyboard.press("v"); await page.waitForTimeout(200);
  assert.equal(await subtitleText(page), "映画を見ましょう。", "原文");
  await page.keyboard.press("v"); await page.waitForTimeout(200);
  assert.equal(await subtitleText(page), "", "关闭");
  await page.keyboard.press("v"); await page.waitForTimeout(200);
  assert.equal(await subtitleText(page), "我们看电影吧。|映画を見ましょう。", "再按回到双语");

  // ] 字幕延后 2 秒：t=6 时本该显示第二条，延后后应显示的是“t-2=4 附近”的内容（第一条 s=1..4 的末尾）
  for (let i = 0; i < 4; i++) await page.keyboard.press("]");
  await page.waitForTimeout(300);
  assert.equal(await subtitleText(page), "你好。|こんにちは。", "字幕延后 2 秒：6s 处显示的是原来 4s 的那条");
  await page.keyboard.press("["); await page.keyboard.press("["); await page.keyboard.press("["); await page.keyboard.press("["); await page.waitForTimeout(300);
  assert.equal(await subtitleText(page), "我们看电影吧。|映画を見ましょう。", "调回 0");

  assert.deepEqual(h.errors, [], "页面不应有未捕获异常");
  console.log("feed-subtitles: all checks passed");
} finally {
  await h?.browser?.close().catch(() => {});
  await h?.vite?.close().catch(() => {});
  await rm(tmp, { recursive: true, force: true });
}
