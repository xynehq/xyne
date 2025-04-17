## FOR PROD & DEV ENV
#!/bin/sh
set -e
mkdir -p models
mkdir -p models/code
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
# models/code/ make folder
# again download model + tokenizer
# 1024
# File paths

CODE_TOKENIZER_URL="https://huggingface.co/Salesforce/SFR-Embedding-Code-400M_R/resolve/main/tokenizer.json"
CODE_MODEL_URL="https://huggingface.co/Salesforce/SFR-Embedding-Code-400M_R/resolve/main/onnx/model_quantized.onnx"
TOKENIZER_FILE="models/tokenizer.json"
MODEL_FILE="models/model.onnx"
CODE_TOKENIZER_FILE="models/code/tokenizer.json"
CODE_MODEL_FILE="models/code/model.onnx"
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
# # Download the code tokenizer if it doesn't exist
if [ -f "$CODE_TOKENIZER_FILE" ]; then
    echo "Code model tokenizer already exists"
else
    echo "Downloading code model tokenizer..."
    curl -L -o "$CODE_TOKENIZER_FILE" "$CODE_TOKENIZER_URL"
fi
# Download the code model if it doesn't exist
if [ -f "$CODE_MODEL_FILE" ]; then
    echo "Code model onnx already exists"
else
    echo "Downloading code model onnx..."
    curl -L -o "$CODE_MODEL_FILE" "$CODE_MODEL_URL"
fi
echo "Deploying vespa..."
vespa deploy --wait 960
echo "Restarting vespa...."
docker restart vespa
# vespa destroy
vespa status --wait 75