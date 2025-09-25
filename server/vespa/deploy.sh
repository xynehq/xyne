## FOR PROD & DEV ENV

#!/bin/sh
set -e

if [ -f ../.env ]; then
  . ../.env
fi

mkdir -p models
TOKENIZER_URL=""
MODEL_URL=""
DIMS=


# URLs to download
if [ "$EMBEDDING_MODEL" = "bge-small-en-v1.5" ] || [ -z "$EMBEDDING_MODEL" ]; then
    TOKENIZER_URL="https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/tokenizer.json"
    MODEL_URL="https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx"
    DIMS=384
    echo "Deploying embedding model: bge-small-en-v1.5"
elif [ "$EMBEDDING_MODEL" = "bge-base-en-v1.5" ]; then
    TOKENIZER_URL="https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/tokenizer.json"
    MODEL_URL="https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/onnx/model.onnx"
    DIMS=768
    echo "Deploying embedding model: $EMBEDDING_MODEL"
elif [ "$EMBEDDING_MODEL" = "bge-large-en-v1.5" ]; then
    TOKENIZER_URL="https://huggingface.co/BAAI/bge-large-en-v1.5/resolve/main/tokenizer.json"
    MODEL_URL="https://huggingface.co/BAAI/bge-large-en-v1.5/resolve/main/onnx/model.onnx"
    DIMS=1024
    echo "Deploying embedding model: $EMBEDDING_MODEL"
else
    echo "Error: Unknown EMBEDDING_MODEL value '$EMBEDDING_MODEL'. please add one of ['bge-small-en-v1.5','bge-base-en-v1.5','bge-large-en-v1.5']"
    exit 1
fi

bun run replaceDIMS.ts "$DIMS"

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


echo "Deploying vespa... $VESPA_CLI_PATH"
${VESPA_CLI_PATH:-vespa} deploy --wait 960
echo "Restarting vespa...."
docker restart vespa
# vespa destroy
${VESPA_CLI_PATH:-vespa} status --wait 75
