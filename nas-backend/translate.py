#!/usr/bin/env python3
"""字幕翻译：NLLB-200（CTranslate2 int8）本地离线翻译，由 server.mjs 调用。

用法：translate.py <模型目录> <源语言 NLLB 码> <目标语言 NLLB 码>
输入：stdin 一个 JSON 字符串数组；输出：stdout 一个等长的 JSON 字符串数组。
进度：stderr 每批输出一行 `PROGRESS <已完成>/<总数>`。
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: translate.py MODEL_DIR SRC_LANG TGT_LANG", file=sys.stderr)
        return 2
    model_dir, src, tgt = sys.argv[1:4]
    lines = json.load(sys.stdin)

    import ctranslate2
    import sentencepiece as spm

    sp = spm.SentencePieceProcessor()
    sp.load(os.path.join(model_dir, "sentencepiece.bpe.model"))
    translator = ctranslate2.Translator(
        model_dir, device="cpu", compute_type="int8",
        inter_threads=1, intra_threads=max(2, (os.cpu_count() or 4) - 2),
    )

    out = [""] * len(lines)
    todo = [i for i, t in enumerate(lines) if t and t.strip()]
    # 长度相近的放一批，padding 少、速度快；结果按原下标放回
    todo.sort(key=lambda i: len(lines[i]))
    batch_size = 16
    done = 0
    for start in range(0, len(todo), batch_size):
        idx = todo[start:start + batch_size]
        sources = [[src] + sp.encode(lines[i].strip(), out_type=str) + ["</s>"] for i in idx]
        results = translator.translate_batch(
            sources, target_prefix=[[tgt]] * len(idx), beam_size=4,
            max_decoding_length=256, repetition_penalty=1.15, no_repeat_ngram_size=4,
        )
        for i, r in zip(idx, results):
            tokens = r.hypotheses[0]
            if tokens and tokens[0] == tgt:
                tokens = tokens[1:]
            out[i] = sp.decode(tokens).strip()
        done += len(idx)
        print(f"PROGRESS {done}/{len(todo)}", file=sys.stderr, flush=True)

    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
