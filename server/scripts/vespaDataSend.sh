#!/bin/bash
set -e
set -o pipefail

# ------------------------------------------------------------
#  STEP 0: AWS Configuration (Non-interactive)
# ------------------------------------------------------------
# ⚠️ Replace with your real credentials
export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
export AWS_DEFAULT_REGION="ap-south-1"
export AWS_DEFAULT_OUTPUT="json"

# AWS performance tuning (optional)
aws configure set default.s3.max_concurrent_requests 20
aws configure set default.s3.multipart_threshold 64MB
aws configure set default.s3.multipart_chunksize 64MB
aws configure set default.s3.max_queue_size 100
aws configure set default.s3.multipart_upload_threshold 64MB
aws configure set default.s3.multipart_max_attempts 5

aws sts get-caller-identity

# ------------------------------------------------------------
#  STEP 1: Start Vespa container (optional if already running)
# ------------------------------------------------------------
# docker run -d --name vespa-testing \
#   -e VESPA_IGNORE_NOT_ENOUGH_MEMORY=true \
#   -p 8181:8080 \
#   -p 19171:19071 \
#   -p 2224:22 \
#   vespaengine/vespa:latest

# ------------------------------------------------------------
#  STEP 2: Export Vespa data
# ------------------------------------------------------------
vespa visit --content-cluster my_content --make-feed > dump.json

# ------------------------------------------------------------
#  STEP 3: Compress dump file
# ------------------------------------------------------------
apt install -y pigz || yum install -y pigz
pigz -9 dump.json   # creates dump.json.gz

# ------------------------------------------------------------
#  STEP 4: Encrypt dump file (AES-256)
# ------------------------------------------------------------
# ⚠️ You’ll be prompted for password — can automate with -pass if needed
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in dump.json.gz \
  -out dump.json.gz.enc

# ------------------------------------------------------------
#  STEP 5: Upload to AWS S3
# ------------------------------------------------------------
aws s3 cp dump.json.gz.enc s3://your-bucket-name/dumps/

# Optional: show progress bar (Linux only)
# aws s3 cp dump.json.gz.enc s3://your-bucket-name/dumps/ --expected-size $(stat -c%s dump.json.gz.enc)

# ------------------------------------------------------------
#  STEP 6: (Optional) Transfer over SSH
# ------------------------------------------------------------
# rsync -avzP --inplace --partial --append -e "ssh -p 2224" dump.json.gz.enc root@192.168.1.6:/home/root/

echo "✅ Vespa dump, compression, encryption, and upload completed successfully!"
