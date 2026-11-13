// 字幕后处理的单元测试（纯逻辑，不需要 whisper / 翻译模型）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { WHISPER_MODELS, WHISPER_VAD_ARGS, cleanCues, parseTranslateProgress, parseWhisperProgress, pickWhisperModel, sentencesFromWhisper } from "../nas-backend/subtitles.mjs";

const tok = (text, from, to) => ({ text, offsets: { from, to } });

test("按句拆分：用词级时间戳定位每句起止", () => {
  const seg = { text: "こんにちは。元気ですか。", offsets: { from: 100, to: 4000 }, tokens: [
    tok("[_BEG_]", 0, 0), tok("こんにちは", 100, 900), tok("。", 900, 1000),
    tok("元気", 1500, 2200), tok("ですか", 2200, 3000), tok("。", 3000, 3300), tok("[_TT_200]", 4000, 4000),
  ] };
  const out = sentencesFromWhisper([seg]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { s: 0.1, e: 1, t: "こんにちは。" });
  assert.equal(out[1].t, "元気ですか。");
  assert.equal(out[1].s, 1.5);
  assert.equal(out[1].e, 3.3);
});

test("静音检测（VAD）模式：词级时间在压缩时间线上，必须以段落起点为锚点还原到原片时间", () => {
  // 真实数据形态：段落起点是原片里的位置（1272s），词级时间却从 12s 开始（静音被拼掉了）
  const seg = { offsets: { from: 1272300, to: 1273200 }, text: "あ、プレゼント。", tokens: [
    tok("[_BEG_]", 0, 0), tok("あ", 12000, 12300), tok("、", 12300, 12400), tok("プレゼント", 12400, 12900), tok("。", 12900, 13000),
  ] };
  const [c] = sentencesFromWhisper([seg]);
  assert.equal(c.s, 1272.3, "句子起点 = 段落起点");
  assert.ok(Math.abs(c.e - 1273.3) < 1e-6, `句子时长按词级差值：${c.e}`);
  // 多段落：结果按原片时间有序，不会被压缩时间线挤到开头
  const many = sentencesFromWhisper([
    { offsets: { from: 500, to: 900 }, tokens: [tok("a。", 0, 400)] },
    { offsets: { from: 509900, to: 510400 }, tokens: [tok("b。", 10000, 10400)] },
    { offsets: { from: 3642500, to: 3643000 }, tokens: [tok("c。", 25000, 25400)] },
  ]);
  assert.deepEqual(many.map((x) => Math.round(x.s)), [1, 510, 3643]);
});

test("没有标点但有长停顿：在停顿处断开；过长的句子强制断开", () => {
  const pause = sentencesFromWhisper([{ tokens: [tok("あ", 0, 300), tok("い", 300, 600), tok("う", 3000, 3300)] }]);
  assert.deepEqual(pause.map((c) => c.t), ["あい", "う"]);
  const long = sentencesFromWhisper([{ tokens: Array.from({ length: 30 }, (_, i) => tok("x", i * 500, i * 500 + 400)) }]);
  assert.ok(long.length >= 2, "超过 9 秒应拆开");
  assert.ok(long.every((c) => c.e - c.s <= 9.5));
});

test("没有词级时间戳时按字数比例分配时间", () => {
  const out = sentencesFromWhisper([{ text: "Hola. ¿Cómo estás?", offsets: { from: 0, to: 4000 } }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].s, 0);
  assert.ok(out[0].e > 0 && Math.abs(out[0].e - out[1].s) < 1e-9 && out[1].e === 4);
});

test("过滤幻听、非语音标注、循环重复，并修正过短 / 重叠的时间", () => {
  const cues = cleanCues([
    { s: 0, e: 2, t: "ご視聴ありがとうございました" },
    { s: 2, e: 4, t: "[音楽]" },
    { s: 4, e: 6, t: "♪~" },
    { s: 6, e: 8, t: "Thank you." },
    { s: 8, e: 9, t: "おはよう" },
    { s: 9, e: 10, t: "おはよう" },
    { s: 10, e: 11, t: "おはよう" },
    { s: 11, e: 12, t: "おはよう" },
    { s: 20, e: 20.1, t: "本物の台詞" },
  ], "ja");
  assert.deepEqual(cues.map((c) => c.t), ["おはよう", "おはよう", "本物の台詞"]);
  assert.ok(cues[2].e - cues[2].s >= 0.6, "过短的字幕要拉长到可读");
  // 英语片里的 Thank you 是真台词
  assert.equal(cleanCues([{ s: 0, e: 1, t: "Thank you." }], "en").length, 1);
  // 重叠的时间被截断，不会盖住下一条
  const o = cleanCues([{ s: 0, e: 5, t: "a" }, { s: 3, e: 6, t: "b" }], "en");
  assert.ok(o[0].e <= o[1].s);
});

test("进度解析", () => {
  assert.equal(parseWhisperProgress("whisper_print_progress_callback: progress =  45%"), 0.45);
  assert.equal(parseWhisperProgress("other"), null);
  assert.equal(parseTranslateProgress("PROGRESS 8/16"), 0.5);
  assert.equal(parseTranslateProgress("hello"), null);
});

test("识别模型：优先 large-v3，没有就回退 turbo，环境变量可强制指定", () => {
  const has = (...names) => (p) => names.some((n) => p.endsWith(n));
  assert.equal(pickWhisperModel("/m", {}, has("ggml-large-v3-q5_0.bin", "ggml-large-v3-turbo-q5_0.bin")), "ggml-large-v3-q5_0.bin");
  assert.equal(pickWhisperModel("/m", {}, has("ggml-large-v3-turbo-q5_0.bin")), "ggml-large-v3-turbo-q5_0.bin", "老安装只有 turbo：回退");
  assert.equal(pickWhisperModel("/m", {}, has()), WHISPER_MODELS[0], "都没有：指向首选，由能力探测报缺失");
  assert.equal(pickWhisperModel("/m", { WHISPER_MODEL: "x.bin" }, has("x.bin", "ggml-large-v3-q5_0.bin")), "x.bin");
});

test("静音检测参数：实测调优值（阈值 0.3、补边 200ms、最短人声 100ms）", () => {
  const a = WHISPER_VAD_ARGS;
  const val = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(val("--vad-threshold"), "0.3");
  assert.equal(val("--vad-speech-pad-ms"), "200");
  assert.equal(val("--vad-min-speech-duration-ms"), "100");
});

test("低阈值人声小段：解析输出、扣掉已覆盖的、合并相邻小段", async () => {
  const { parseVadSegments, pendingRegions } = await import("../nas-backend/subtitles.mjs");
  const text = "Detected 4 speech segments:\nSpeech segment 0: start = 104.00, end = 222.00\nSpeech segment 1: start = 293.00, end = 372.00\nSpeech segment 2: start = 1592.00, end = 1697.00\nSpeech segment 3: start = 10319.00, end = 10401.00\n";
  const r = parseVadSegments(text);
  assert.deepEqual(r, [{ s: 1.04, e: 2.22 }, { s: 2.93, e: 3.72 }, { s: 15.92, e: 16.97 }, { s: 103.19, e: 104.01 }]);
  // 前两段间隔 0.71s → 合成一个片段；第三段已被对白覆盖 → 扣掉
  const todo = pendingRegions(r, [{ s: 15, e: 18 }]);
  assert.deepEqual(todo, [{ s: 1.04, e: 3.72 }, { s: 103.19, e: 104.01 }]);
  // 片段不超过 maxLen
  const long = pendingRegions([{ s: 0, e: 6 }, { s: 6.5, e: 12 }, { s: 12.5, e: 18 }], [], { maxLen: 12 });
  assert.equal(long.length, 2);
});

test("呻吟类识别：只认整句都是发声的文本，压缩循环，并带上中文行", async () => {
  const { isMoanText, condenseMoan, tagMoans } = await import("../nas-backend/subtitles.mjs");
  assert.ok(isMoanText("ああああああ"));
  assert.ok(isMoanText("はぁはぁはぁはぁ"));
  assert.ok(isMoanText("あっ…あぁ、んっ"));
  assert.ok(isMoanText("Ah, ah, ah! Mmm..."));
  assert.ok(isMoanText("啊…嗯"));
  assert.ok(!isMoanText("すごい"));
  assert.ok(!isMoanText("気持ちいい"));
  assert.ok(!isMoanText("Yes, ah, come here"));
  assert.ok(!isMoanText(""));
  assert.equal(condenseMoan("ああああああああああああ"), "ああ…");
  assert.equal(condenseMoan("Ah, ah, ah, ah, ah, ah"), "Ah, ah, ah…");
  const out = tagMoans([{ s: 1, e: 3, t: "はぁはぁはぁはぁはぁはぁ" }, { s: 5, e: 6, t: "ごめんね" }]);
  assert.deepEqual(out[0], { s: 1, e: 3, t: "はぁはぁ…", z: "啊…" });
  assert.deepEqual(out[1], { s: 5, e: 6, t: "ごめんね" });
});

test("合并：对白优先，与对白重叠的补充字幕丢弃，结果按时间排序且不重叠", async () => {
  const { mergeCues } = await import("../nas-backend/subtitles.mjs");
  const speech = [{ s: 10, e: 14, t: "こんにちは" }];
  const extra = [{ s: 2, e: 5, t: "ああ…", z: "啊…" }, { s: 11, e: 13, t: "ああ…", z: "啊…" }, { s: 14.1, e: 16, t: "んっ…", z: "啊…" }, { s: 20, e: 20.2, t: "あ…", z: "啊…" }];
  const out = mergeCues(speech, extra);
  assert.deepEqual(out.map((c) => c.s), [2, 10, 20]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].s >= out[i - 1].e);
  assert.ok(out[2].e - out[2].s >= 0.6);
});

test("LLM 翻译：编号解析、可用性判断、模型挑选", async () => {
  const { parseNumbered, usable, pickLlmModel, userPrompt } = await import("../nas-backend/translate-llm.mjs");
  assert.deepEqual(parseNumbered("1. 再来一次\n2、不行！\n4. 好的\n废话", 4), ["再来一次", "不行！", "", "好的"]);
  assert.deepEqual(parseNumbered("1. “真的吗？”\n1. 重复的第二个", 2), ["真的吗？", ""]); // 引号去掉；重复编号只取第一个
  assert.ok(usable("ダメ!", "不行！", "ja"));
  assert.ok(!usable("ダメ!", "", "ja"));
  assert.ok(!usable("ダメ!", "ダメ!", "ja")); // 原样抄回
  assert.ok(!usable("すごい", "すごいね", "ja")); // 译文里还有假名
  assert.ok(!usable("マジなの?", "serious吗？", "ja")); // 夹英文单词
  assert.ok(usable("OK?", "OK吗？", "en"));
  assert.ok(usable("¿Qué?", "什么？", "es"));
  assert.ok(!usable("Hola", "Hola", "es"));
  const files = ["a.bin", "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf", "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"];
  assert.equal(pickLlmModel("/m", {}, () => files), "/m/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"); // 多分片取第一片
  assert.equal(pickLlmModel("/m", {}, () => ["x.bin"]), null);
  assert.match(userPrompt(["ダメ!"], [{ t: "はい", z: "好的" }]), /前文[\s\S]*はい → 好的[\s\S]*1\. ダメ!/);
});

test("Sakura（日译中专用）：提问格式、按行解析、行数对不上返回 null、模型挑选", async () => {
  const { sakuraUser, parseSakura, pickSakuraModel } = await import("../nas-backend/translate-llm.mjs");
  assert.equal(sakuraUser(["ダメ!", "はい"], ["すごい"]), "将下面的日文文本翻译成中文：\nすごい\nダメ!\nはい");
  assert.deepEqual(parseSakura("真棒\n不行！\n好的\n", 2, 1), ["不行！", "好的"]); // 前 1 行是上下文
  assert.equal(parseSakura("不行！好的", 2, 0), null); // 合并成一行 → 对不上
  const files = ["qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf", "sakura-7b-qwen2.5-v1.0-iq4xs.gguf"];
  assert.equal(pickSakuraModel("/m", {}, () => files), "/m/sakura-7b-qwen2.5-v1.0-iq4xs.gguf");
  assert.equal(pickSakuraModel("/m", { NO_SAKURA: "1" }, () => files), null);
  assert.equal(pickSakuraModel("/m", {}, () => ["x.gguf"]), null);
});
