#!/bin/sh
# 安装字幕生成所需的本地组件（语音识别 + 翻译），全部在本机运行，不会把音频或台词发到外部服务。
#   用法：  ./setup-subtitles.sh [模型目录]
#   默认模型目录与应用托管的后端一致：~/Library/Application Support/com.hghubx.app/nas-cache/models
# 组件：
#   whisper.cpp（brew，Metal 加速）+ ggml-large-v3-q5_0（≈1.1GB，识别日语 / 西班牙语等 99 种语言；比 turbo 在日语上准得多）
#   llama.cpp（brew）+ Sakura-7B（日译中专用，≈4.2GB，CC-BY-NC-SA 仅限非商用）+ Qwen2.5-7B-Instruct（其它语言，≈4.7GB）：首选翻译；SKIP_LLM=1 可跳过，会回退到 NLLB
#   Python venv：ctranslate2 + sentencepiece + huggingface_hub，翻译模型 NLLB-200 distilled 1.3B（int8，≈1.4GB）
set -eu
MODELS="${1:-$HOME/Library/Application Support/com.hghubx.app/nas-cache/models}"
WHISPER_MODEL="${WHISPER_MODEL:-ggml-large-v3-q5_0.bin}"
NLLB_REPO="${NLLB_REPO:-JustFrederik/nllb-200-distilled-1.3B-ct2-int8}"
PY="${PYTHON:-python3}"
mkdir -p "$MODELS"
echo "模型目录：$MODELS"

if ! command -v whisper-cli >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { echo "需要 Homebrew（https://brew.sh）来安装 whisper.cpp" >&2; exit 1; }
  echo "==> 安装 whisper.cpp"; brew install whisper-cpp
fi

if [ ! -s "$MODELS/$WHISPER_MODEL" ]; then
  echo "==> 下载语音识别模型 $WHISPER_MODEL"
  curl -fL --retry 3 -C - -o "$MODELS/$WHISPER_MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL"
  mv "$MODELS/$WHISPER_MODEL.part" "$MODELS/$WHISPER_MODEL"
fi

# 静音检测（VAD，≈0.9MB）：跳过没有人声的段落，明显减少“幻听”并加快识别
if [ ! -s "$MODELS/ggml-silero-v5.1.2.bin" ]; then
  echo "==> 下载静音检测模型"
  curl -fL --retry 3 -o "$MODELS/ggml-silero-v5.1.2.bin" "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
fi

if [ ! -x "$MODELS/venv/bin/python" ]; then
  echo "==> 创建 Python 环境"; "$PY" -m venv "$MODELS/venv"
fi
"$MODELS/venv/bin/pip" install -q --upgrade pip
"$MODELS/venv/bin/pip" install -q ctranslate2 sentencepiece huggingface_hub

if [ ! -s "$MODELS/nllb/model.bin" ]; then
  echo "==> 下载翻译模型 $NLLB_REPO"
  "$MODELS/venv/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('$NLLB_REPO', local_dir='$MODELS/nllb')"
fi
if [ "${SKIP_LLM:-0}" != "1" ]; then
  command -v llama-server >/dev/null 2>&1 || { echo "==> 安装 llama.cpp"; brew install llama.cpp; }
  if ! ls "$MODELS"/llm/sakura-7b-qwen2.5-*.gguf >/dev/null 2>&1; then
    echo "==> 下载日译中模型 Sakura-7B（≈4.2GB）"
    "$MODELS/venv/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('SakuraLLM/Sakura-7B-Qwen2.5-v1.0-GGUF', allow_patterns=['sakura-7b-qwen2.5-v1.0-iq4xs.gguf'], local_dir='$MODELS/llm')"
  fi
  if ! ls "$MODELS"/llm/qwen2.5-7b-instruct-*.gguf >/dev/null 2>&1; then
    echo "==> 下载翻译模型 Qwen2.5-7B-Instruct（≈4.7GB）"
    "$MODELS/venv/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen2.5-7B-Instruct-GGUF', allow_patterns=['qwen2.5-7b-instruct-q4_k_m*.gguf'], local_dir='$MODELS/llm')"
  fi
fi
echo "完成。重启后端（或应用）即可使用字幕生成。"
