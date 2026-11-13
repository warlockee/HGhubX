// 片库定期刷新的后端测试：增删后版本号变化；网络盘暂时不可用 / 结果骤降时保留旧片库，连续两次确认才接受。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(path.join(tmpdir(), "hg-lib-"));
const media = path.join(tmp, "media");
await mkdir(path.join(media, "A"), { recursive: true });
await mkdir(path.join(media, "B"), { recursive: true });
const add = (cat, n) => writeFile(path.join(media, cat, `v${n}.mp4`), "x");
for (let i = 1; i <= 6; i++) await add(i <= 3 ? "A" : "B", i);

const port = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, [path.join(here, "../nas-backend/server.mjs"), media, "--port", String(port), "--cache", path.join(tmp, "cache")], { stdio: "ignore" });
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const s0 = await get("/library/status");
  assert.equal(s0.count, 6); assert.equal(s0.categories, 2); assert.ok(s0.version);
  const ids0 = (await get("/library/ids")).ids;
  assert.equal(ids0.length, 6);

  // 没变化：重扫后版本号不变
  assert.equal((await get("/library/refresh")).version, s0.version, "没有增删时版本号不变");

  // 新增一个：版本号变，数量 +1，ids 里有新的
  await add("A", 7);
  const s1 = await get("/library/refresh");
  assert.equal(s1.count, 7); assert.notEqual(s1.version, s0.version);
  assert.equal((await get("/library/ids")).ids.length, 7);

  // 删掉一个（6/7，没有骤降）：直接接受
  await rm(path.join(media, "A", "v7.mp4"));
  const s2 = await get("/library/refresh");
  assert.equal(s2.count, 6); assert.equal(s2.version, s0.version, "删掉新增的那个，片库回到原样，版本号也回到原值");

  // 网络盘暂时不可用：根目录没了 → 保留旧片库
  await rename(media, media + "_gone");
  const s3 = await get("/library/refresh");
  assert.equal(s3.count, 6, "共享暂时读不到时保留旧片库");
  assert.equal(s3.version, s0.version);
  await rename(media + "_gone", media);

  // 一个子目录整个读不出来，再少一个：结果骤降到 2/6（不到一半）
  await rename(path.join(media, "B"), path.join(tmp, "B_gone")); // 移到片库根目录外，等于“读不出来”
  await rm(path.join(media, "A", "v3.mp4"));
  const s4 = await get("/library/refresh"); // 6 → 2：骤降，第一次保留
  assert.equal(s4.count, 6, "骤降第一次先保留旧片库");
  const s5 = await get("/library/refresh"); // 连续第二次仍然是 2：接受
  assert.equal(s5.count, 2, "连续两次确认后接受新结果");
  assert.notEqual(s5.version, s0.version);

  console.log("library: all checks passed");
} finally {
  server.kill("SIGKILL");
  await rm(tmp, { recursive: true, force: true });
}
