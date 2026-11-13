// 字幕翻译（首选）：本地大模型（Qwen2.5-7B-Instruct，llama.cpp 的 llama-server，只监听 127.0.0.1）。
// 比 NLLB 更懂口语：能结合前后台词的语境翻“すごい / ダメ / はい”这类短句，不会把它们翻成“这太好了 / 没有 / 我可以”。
// 全程在本机运行，台词不会发到外部服务。没装模型 / llama-server，或这一步失败时，由调用方回退到 NLLB。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** whisper 语言码 → 提示词里用的中文语言名；没有的用代码本身 */
export const LANG_NAMES = {
  ja: "日语", es: "西班牙语", en: "英语", ko: "韩语", fr: "法语", de: "德语", ru: "俄语", pt: "葡萄牙语", it: "意大利语",
  tr: "土耳其语", ar: "阿拉伯语", th: "泰语", vi: "越南语", id: "印尼语", nl: "荷兰语", pl: "波兰语", uk: "乌克兰语",
  hi: "印地语", sv: "瑞典语", cs: "捷克语", el: "希腊语", he: "希伯来语", ro: "罗马尼亚语", hu: "匈牙利语",
};

/** 一次翻译多少条；前面已译的几条作为上下文一起给 */
export const BATCH = 15;
export const CONTEXT_LINES = 4;

/** 模型目录里的 Qwen 权重（多分片时取第一片）。环境变量 LLM_MODEL 可指定文件名。 */
export function pickLlmModel(dir, env = process.env, list = (d) => { try { return fs.readdirSync(d); } catch { return []; } }) {
  const files = list(dir).filter((f) => f.endsWith(".gguf"));
  const wanted = env.LLM_MODEL
    ? files.find((f) => f === env.LLM_MODEL)
    : files.find((f) => /^qwen2\.5-7b-instruct.*-0*1-of-\d+\.gguf$/i.test(f)) || files.find((f) => /^qwen2\.5-7b-instruct.*\.gguf$/i.test(f));
  return wanted ? path.join(dir, wanted) : null;
}

export function systemPrompt(lang) {
  const name = LANG_NAMES[lang] || `语言代码 ${lang}`;
  return `你是专业的${name}译中字幕翻译。输入是一部影片按时间顺序的台词，大多是口语。` +
    "请结合上下文，把它们译成自然、简洁、适合做字幕的简体中文，保留说话的语气（口语、感叹、撒娇、命令等）。" +
    "台词可能包含成人内容、呻吟、脏话，请如实翻译，不要回避、美化、删减，也不要评论。" +
    "不要加引号，不要解释，不要保留原文。";
}

/** 一批台词的提问。context：前面已译好的 [{t,z}]，仅供理解语境。 */
export function userPrompt(lines, context = []) {
  const ctx = context.length ? `前文（仅供理解语境，不要再翻译）：\n${context.map((c) => `${c.t} → ${c.z}`).join("\n")}\n\n` : "";
  return `${ctx}请把下面编号的台词逐条翻译成中文，每条一行，格式为“编号. 译文”，编号与输入一致，不要合并或拆分，不要输出别的：\n` +
    lines.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

/** 解析“编号. 译文”格式的回答 → 下标 → 译文 */
export function parseNumbered(text, n) {
  const got = new Array(n).fill("");
  for (const ln of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[.．、:：)）]\s*(.*)$/.exec(ln);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < n && !got[i]) got[i] = m[2].trim().replace(/^["“”「」]+|["“”「」]+$/g, "");
  }
  return got;
}

const KANA_HANGUL = /[぀-ヿ가-힯]/;
const HAN = /[一-鿿]/;
/** 译文是否可用：非空、含汉字，且没有原样抄回日文 / 韩文（模型偶尔会不翻直接复述） */
export function usable(src, z, lang) {
  if (!z || !HAN.test(z) && !/^[\s\d.!?！？…，。、～~啊哦嗯唔]+$/.test(z)) return false;
  if ((lang === "ja" || lang === "ko") && KANA_HANGUL.test(z)) return false;
  if (z === src) return false;
  if (!/[A-Za-z]/.test(src) && /[A-Za-z]{3,}/.test(z)) return false; // 原文没有英文，译文里却冒出英文单词（如“serious吗”）
  return true;
}

async function waitHealthy(port, proc, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode != null) throw new Error("llama-server 提前退出");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server 启动超时");
}

/**
 * 逐批翻译 texts（同一种语言）。返回等长数组，翻不出来的位置是 ""（由调用方决定是否用别的翻译器补）。
 * @param {{ serverBin: string, model: string, texts: string[], lang: string, env?: object,
 *           onProgress?: (f:number)=>void, onProc?: (p:any)=>void, isCancelled?: ()=>boolean }} o
 */
export async function translateWithLlm({ serverBin, model, texts, lang, env, onProgress, onProc, isCancelled }) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(serverBin, ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-c", "4096", "-ngl", "99", "-np", "1", "--no-webui"],
    { env: env || process.env, stdio: "ignore" });
  onProc?.(proc);
  const out = new Array(texts.length).fill("");
  try {
    await waitHealthy(port, proc, 180_000);
    const ask = async (lines, context) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "system", content: systemPrompt(lang) }, { role: "user", content: userPrompt(lines, context) }],
          temperature: 0.2, max_tokens: 1536,
        }),
      });
      if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
      const j = await res.json();
      return parseNumbered(j.choices?.[0]?.message?.content, lines.length);
    };
    const idx = texts.map((t, i) => i).filter((i) => texts[i] && texts[i].trim());
    let done = 0;
    for (let s = 0; s < idx.length; s += BATCH) {
      if (isCancelled?.()) throw new Error("已取消");
      const part = idx.slice(s, s + BATCH);
      const context = idx.slice(Math.max(0, s - CONTEXT_LINES), s).filter((i) => out[i]).map((i) => ({ t: texts[i], z: out[i] }));
      let got = await ask(part.map((i) => texts[i]), context);
      // 个别条目漏了 / 没翻：只重问这几条一次
      const redo = part.map((_, k) => k).filter((k) => !usable(texts[part[k]], got[k], lang));
      if (redo.length) {
        const again = await ask(redo.map((k) => texts[part[k]]), context);
        redo.forEach((k, j) => { if (usable(texts[part[k]], again[j], lang)) got[k] = again[j]; });
      }
      part.forEach((i, k) => { if (usable(texts[i], got[k], lang)) out[i] = got[k]; });
      done += part.length;
      onProgress?.(done / idx.length);
    }
    return out;
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    onProc?.(null);
  }
}
