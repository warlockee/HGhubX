// 字幕生成：本地语音识别（whisper.cpp）+ 本地翻译（NLLB-200 / CTranslate2）。
// 全程在本机运行，音频和台词都不会发到外部服务。组件用 setup-subtitles.sh 安装。
//
// 流程：ffmpeg 抽音频 → whisper-cli 识别（带词级时间戳，Metal 加速）→ 按句拆分并过滤“幻听”
//       → translate.py 翻译成中文 → 写入 cache/subs/<id>/<ep>/cues.json。
// 任务串行执行（CPU / GPU 吃紧），状态与进度通过 status() 查询。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ───────────── 纯函数（有单元测试） ───────────── */

/** whisper 语言码 → NLLB 语言码；没有的语言不翻译，只给原文字幕 */
export const NLLB = {
  ja: "jpn_Jpan", es: "spa_Latn", en: "eng_Latn", ko: "kor_Hang", fr: "fra_Latn", de: "deu_Latn", ru: "rus_Cyrl",
  pt: "por_Latn", it: "ita_Latn", tr: "tur_Latn", ar: "arb_Arab", th: "tha_Thai", vi: "vie_Latn", id: "ind_Latn",
  nl: "nld_Latn", pl: "pol_Latn", uk: "ukr_Cyrl", hi: "hin_Deva", sv: "swe_Latn", cs: "ces_Latn", el: "ell_Grek",
  he: "heb_Hebr", ro: "ron_Latn", hu: "hun_Latn", fa: "pes_Arab", ms: "zsm_Latn", tl: "tgl_Latn",
};

const SENTENCE_END = /[。！？!?．.…‥]\s*$/;
const isSpecialToken = (t) => /^\[_.*_?\d*\]$/.test(t.trim());
/** 同一句里相邻两个词之间超过这个间隔（毫秒）就当作停顿，另起一条字幕 */
const PAUSE_MS = 1200;
/** 一条字幕最长持续（毫秒）；没有标点的长句到这里强制断开 */
const MAX_CUE_MS = 9000;

/** whisper `-ojf` 的 transcription → 句级字幕 [{s,e,t}]（秒）。用词级时间戳定位每句的起止；没有词级时间时按字数比例分配。 */
export function sentencesFromWhisper(transcription) {
  const out = [];
  for (const seg of transcription || []) {
    const tokens = (seg.tokens || []).filter((k) => !isSpecialToken(k.text) && k.text !== "");
    const timed = tokens.length > 0 && tokens.some((k) => k.offsets && k.offsets.to > k.offsets.from);
    if (timed) {
      // 开了静音检测（VAD）时，whisper 的词级时间戳在“去掉静音后拼起来的时间线”上，段落级起点才是原片里的真实位置。
      // 所以以段落起点为锚点，只取词级时间之间的相对差：句子时间 = 段落起点 + (词时间 − 本段第一个词的时间)。
      const base = Number.isFinite(seg.offsets?.from) ? seg.offsets.from - tokens[0].offsets.from : 0;
      let cur = null;
      const push = () => { if (cur && cur.t.trim()) out.push({ s: cur.s / 1000, e: Math.max(cur.e, cur.s + 400) / 1000, t: cur.t.trim() }); cur = null; };
      for (const k of tokens) {
        const from = k.offsets.from + base, to = Math.max(k.offsets.to, k.offsets.from) + base;
        if (cur && (from - cur.e > PAUSE_MS || to - cur.s > MAX_CUE_MS)) push();
        if (!cur) cur = { s: from, e: to, t: "" };
        cur.t += k.text;
        cur.e = Math.max(cur.e, to);
        if (SENTENCE_END.test(k.text)) push();
      }
      push();
    } else {
      // 没有词级时间戳：按句号切开，时间按字数比例分配
      const text = (seg.text || "").trim();
      if (!text) continue;
      const parts = text.split(/(?<=[。！？!?．.…‥])\s*/).filter((p) => p.trim());
      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      const from = seg.offsets?.from ?? 0, span = Math.max((seg.offsets?.to ?? from) - from, 400);
      let acc = 0;
      for (const p of parts) {
        const s = from + (span * acc) / total;
        acc += p.length;
        out.push({ s: s / 1000, e: (from + (span * acc) / total) / 1000, t: p.trim() });
      }
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/** 识别模型在静音 / 音乐 / 呻吟段常见的“幻听”，原样丢弃 */
const HALLUCINATIONS = [
  /ご視聴ありがとう/, /チャンネル登録/, /高評価/, /字幕\s*[:：]/, /ありがとうございました[。.!！]*$/,
  /thanks for watching/i, /subscribe/i, /amara\.org/i, /subt[ií]tulos/i, /suscr[ií]bete/i, /gracias por (ver|mirar)/i,
  /请不吝点赞|订阅|字幕由/, /^[\s♪♬♫~〜\-ー・.。、,，!！?？]*$/,
];
const NON_SPEECH_TAG = /^[\s]*[\[(（【《♪♬♫].*[\])）】》♪♬♫]?[\s]*$/;

/** 过滤幻听、非语音标注、循环重复；修正过短 / 重叠的时间 */
export function cleanCues(cues, language) {
  const kept = [];
  let lastText = "", run = 0;
  for (const c of cues) {
    const text = c.t.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (NON_SPEECH_TAG.test(text) && text.length <= 24) continue;
    if (HALLUCINATIONS.some((re) => re.test(text))) continue;
    if (language !== "en" && /^thank you[.!]*$/i.test(text)) continue; // 非英语片里孤零零的 Thank you 基本是幻听
    run = text === lastText ? run + 1 : 1;
    lastText = text;
    if (run > 2) continue; // 循环重复：只留前两条
    kept.push({ s: c.s, e: c.e, t: text });
  }
  for (let i = 0; i < kept.length; i++) {
    const next = kept[i + 1];
    if (kept[i].e - kept[i].s < 0.6) kept[i].e = kept[i].s + 0.6;
    if (next && kept[i].e > next.s) kept[i].e = Math.max(kept[i].s + 0.3, next.s - 0.02);
  }
  return kept;
}

export const parseWhisperProgress = (line) => { const m = /progress\s*=\s*(\d+)%/.exec(line); return m ? Number(m[1]) / 100 : null; };
export const parseTranslateProgress = (line) => { const m = /^PROGRESS (\d+)\/(\d+)/.exec(line); return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null; };

/* ───────────── 任务管理 ───────────── */

/**
 * @param {{ cacheDir: string, modelsDir: string, fileOf: (id:number, ep:number) => string|null,
 *           durationOf: (file:string) => Promise<number>, pathEnv?: string }} opts
 */
export function createSubtitles({ cacheDir, modelsDir, fileOf, durationOf, pathEnv }) {
  const env = { ...process.env, PATH: pathEnv || process.env.PATH };
  const WHISPER_MODEL = path.join(modelsDir, process.env.WHISPER_MODEL || "ggml-large-v3-turbo-q5_0.bin");
  const VAD_MODEL = path.join(modelsDir, "ggml-silero-v5.1.2.bin");
  const PY = path.join(modelsDir, "venv/bin/python");
  const NLLB_DIR = path.join(modelsDir, "nllb");
  const TRANSLATE = path.join(HERE, "translate.py");
  const dirOf = (id, ep) => path.join(cacheDir, "subs", String(id), String(ep));
  const keyOf = (id, ep) => `${id}/${ep}`;

  const which = (name) => (env.PATH || "").split(":").map((d) => path.join(d, name)).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

  function capabilities() {
    const whisper = which("whisper-cli");
    const missing = [];
    if (!whisper) missing.push("whisper-cli（brew install whisper-cpp）");
    if (!fs.existsSync(WHISPER_MODEL)) missing.push("语音识别模型");
    const translate = fs.existsSync(PY) && fs.existsSync(path.join(NLLB_DIR, "model.bin"));
    return {
      asr: missing.length === 0,
      vad: fs.existsSync(VAD_MODEL),
      translate,
      missing,
      note: missing.length ? "运行 nas-backend/setup-subtitles.sh 安装字幕组件" : translate ? "" : "未安装翻译组件，只能生成原文字幕",
    };
  }

  /** key -> { state: queued|running|error, stage, progress, message, language, proc, cancelled } */
  const jobs = new Map();
  const queue = [];
  let busy = false;

  const readCues = (id, ep) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id, ep), "cues.json"), "utf8")); } catch { return null; } };

  function status(id, ep) {
    const job = jobs.get(keyOf(id, ep));
    if (job) {
      return { state: job.state, stage: job.stage, progress: job.progress, message: job.message, language: job.language,
        queued: job.state === "queued" ? queue.indexOf(job) + 1 : 0 };
    }
    const done = readCues(id, ep);
    if (done) return { state: "done", language: done.language, translated: done.translated, version: done.version, count: done.cues.length, message: done.note || "" };
    return { state: "idle" };
  }

  function cues(id, ep) { return readCues(id, ep); }

  const setStage = (job, stage, message, base, span, frac = 0) => {
    job.stage = stage; job.message = message;
    job.progress = Math.min(0.999, base + span * Math.max(0, Math.min(1, frac)));
  };

  /** 跑一个子进程，逐行回调 stdout / stderr；被取消或非 0 退出时抛错 */
  function exec(job, cmd, args, { onOut, onErr, input } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
      job.proc = p;
      let stdout = "", errTail = "";
      const lines = (cb) => { let buf = ""; return (d) => { buf += d; let i; while ((i = buf.search(/[\r\n]/)) >= 0) { cb(buf.slice(0, i)); buf = buf.slice(i + 1); } }; };
      p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
      p.stdout.on("data", (d) => { stdout += d; });
      if (onOut) p.stdout.on("data", lines(onOut));
      p.stderr.on("data", (d) => { errTail = (errTail + d).slice(-1500); });
      if (onErr) p.stderr.on("data", lines(onErr));
      p.on("error", reject);
      p.on("close", (code) => {
        job.proc = null;
        if (job.cancelled) return reject(new Error("已取消"));
        code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${errTail.trim().split("\n").slice(-3).join(" | ")}`));
      });
      if (input) { p.stdin.on("error", () => {}); p.stdin.end(input); }
    });
  }

  async function runJob(job, id, ep) {
    const file = fileOf(id, ep);
    if (!file) throw new Error("找不到视频文件");
    const caps = capabilities();
    if (!caps.asr) throw new Error(`缺少字幕组件：${caps.missing.join("、")}`);
    const dir = dirOf(id, ep);
    await fsp.mkdir(dir, { recursive: true });
    const wav = path.join(dir, "audio.wav");
    const out = path.join(dir, "whisper");
    try {
      // 1) 抽音频（16kHz 单声道）。要读完整个文件，网络盘上占大头
      setStage(job, "extract", "正在提取音频…", 0, 0.1);
      const duration = await durationOf(file).catch(() => 0);
      await exec(job, "ffmpeg", ["-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], {
        onOut: (l) => { const m = /^out_time_(?:us|ms)=(\d+)/.exec(l); if (m && duration > 0) setStage(job, "extract", "正在提取音频…", 0, 0.1, Number(m[1]) / 1e6 / duration); },
      });

      // 2) 语音识别
      setStage(job, "transcribe", "正在识别语音…", 0.1, 0.65);
      const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
      const wargs = ["-m", WHISPER_MODEL, "-f", wav, "-l", job.requestLang, "-ojf", "-of", out, "-t", threads, "-pp", "-sns"];
      if (caps.vad) wargs.push("--vad", "-vm", VAD_MODEL);
      await exec(job, "whisper-cli", wargs, { onErr: (l) => { const f = parseWhisperProgress(l); if (f != null) setStage(job, "transcribe", "正在识别语音…", 0.1, 0.65, f); } });
      const result = JSON.parse(await fsp.readFile(out + ".json", "utf8"));
      const language = result.result?.language || (job.requestLang !== "auto" ? job.requestLang : "en");
      job.language = language;
      const list = cleanCues(sentencesFromWhisper(result.transcription), language);

      // 3) 翻译成中文（中文原片不用翻；没装翻译组件或不支持的语言只给原文）
      let translated = false, note = "";
      if (list.length && language !== "zh" && NLLB[language] && caps.translate) {
        setStage(job, "translate", "正在翻译成中文…", 0.75, 0.25);
        const stdout = await exec(job, PY, [TRANSLATE, NLLB_DIR, NLLB[language], "zho_Hans"], {
          input: JSON.stringify(list.map((c) => c.t)),
          onErr: (l) => { const f = parseTranslateProgress(l); if (f != null) setStage(job, "translate", "正在翻译成中文…", 0.75, 0.25, f); },
        });
        const zh = JSON.parse(stdout);
        list.forEach((c, i) => { if (zh[i]) c.z = zh[i]; });
        translated = true;
      } else if (language !== "zh") {
        note = !NLLB[language] ? "该语言暂不支持翻译，仅有原文字幕" : !caps.translate ? "未安装翻译组件，仅有原文字幕" : "";
      }
      const doc = { version: String(Date.now()), language, translated, note, createdAt: new Date().toISOString(), cues: list };
      await fsp.writeFile(path.join(dir, "cues.json.tmp"), JSON.stringify(doc));
      await fsp.rename(path.join(dir, "cues.json.tmp"), path.join(dir, "cues.json"));
      console.log(`[sub] ${id}/${ep} 完成：${language} ${list.length} 条${translated ? "（已翻译）" : ""}`);
    } finally {
      fsp.rm(wav, { force: true }).catch(() => {});
      fsp.rm(out + ".json", { force: true }).catch(() => {});
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        const [id, ep] = job.key.split("/").map(Number);
        job.state = "running"; job.message = "准备中…";
        try { await runJob(job, id, ep); jobs.delete(job.key); }
        catch (e) {
          if (job.cancelled) jobs.delete(job.key);
          else { console.error(`[sub] ${job.key} 失败：${e.message}`); job.state = "error"; job.message = e.message; job.proc = null; }
        }
      }
    } finally { busy = false; }
  }

  /** 开始生成；已有字幕且未 force 则直接返回现状 */
  function start(id, ep, { lang = "auto", force = false } = {}) {
    const key = keyOf(id, ep);
    const existing = jobs.get(key);
    if (existing && existing.state !== "error") return status(id, ep);
    if (!force && readCues(id, ep)) return status(id, ep);
    if (!fileOf(id, ep)) return { state: "error", message: "找不到视频文件" };
    jobs.delete(key);
    const requestLang = /^[a-z]{2,3}$/.test(lang) || lang === "auto" ? lang : "auto";
    const job = { key, state: "queued", stage: "queued", progress: 0, message: "排队中…", language: requestLang === "auto" ? "" : requestLang, requestLang, proc: null, cancelled: false };
    jobs.set(key, job);
    queue.push(job);
    void pump();
    return status(id, ep);
  }

  function cancel(id, ep) {
    const key = keyOf(id, ep);
    const job = jobs.get(key);
    if (!job) return status(id, ep);
    job.cancelled = true;
    const qi = queue.indexOf(job);
    if (qi >= 0) queue.splice(qi, 1);
    try { job.proc?.kill("SIGKILL"); } catch { /* 已退出 */ }
    jobs.delete(key);
    return status(id, ep);
  }

  /** 删除已生成的字幕（重新生成前用） */
  function remove(id, ep) { fs.rmSync(dirOf(id, ep), { recursive: true, force: true }); return status(id, ep); }

  function shutdown() { for (const j of jobs.values()) { j.cancelled = true; try { j.proc?.kill("SIGKILL"); } catch { /* ignore */ } } }

  return { capabilities, status, start, cancel, remove, cues, shutdown };
}
