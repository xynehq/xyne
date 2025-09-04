#!/bin/sh
set -e

vespa config set target $VESPA_URL

mkdir -p models

# URLs to download
TOKENIZER_URL="https://huggingface.co/Xenova/bge-small-en-v1.5/raw/main/tokenizer.json"
MODEL_URL="https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx"

# File paths
TOKENIZER_FILE="models/tokenizer.json"
MODEL_FILE="models/model_quantized.onnx"

# Download the tokenizer if it doesn't exist
if [ -f "$TOKENIZER_FILE" ]; then
    echo "Model tokenizer already exists"
else
    echo "Downloading model tokenizer..."
    curl -L -o "$TOKENIZER_FILE" "$TOKENIZER_URL"
fi

# Download the model if it doesn't exist
if [ -f "$MODEL_FILE" ]; then
    echo "Model onnx already exists"
else
    echo "Downloading model onnx..."
    curl -L -o "$MODEL_FILE" "$MODEL_URL"
fi

vespa deploy --target $VESPA_URL
# vespa destroy
vespa status --wait 55 --target $VESPA_URL