#!/bin/sh
set -e

mkdir -p models

# URLs to download
TOKENIZER_URL="https://huggingface.co/BAAI/bge-large-en-v1.5/resolve/main/tokenizer.json"
MODEL_URL="https://huggingface.co/BAAI/bge-large-en-v1.5/resolve/main/onnx/model.onnx"


# File paths
TOKENIZER_FILE="models/tokenizer.json"
MODEL_FILE="models/model.onnx"

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

vespa deploy --wait 500
docker restart vespa
# vespa destroy
vespa status --wait 55
