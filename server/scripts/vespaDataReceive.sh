#!/bin/bash
set -e
set -o pipefail

# ------------------------------------------------------------
#  STEP 7: Retrieve and Decrypt Vespa Dump
# ------------------------------------------------------------

# ---------- Option 1 — using AWS S3 ----------
# ⚠️ Replace with your actual bucket name and path
aws s3 cp s3://your-bucket-name/dumps/dump.json.gz.enc .

# Decrypt AES-256 encrypted dump (you’ll be prompted for password)
openssl enc -d -aes-256-cbc -pbkdf2 -salt \
  -in dump.json.gz.enc \
  -out dump.json.gz


# ---------- Option 2 — using GPG ----------
# Uncomment these lines if you used GPG encryption instead of OpenSSL

# yum install -y pinentry || apt install -y pinentry
# gpgconf --kill gpg-agent
# export GPG_TTY=$(tty)
# echo $GPG_TTY
# gpg --import my-private-key.asc
# gpg --list-secret-keys
# gpg --output dump.json.gz --decrypt dump.json.gz.gpg


# ------------------------------------------------------------
#  STEP 8: Decompress and Feed into Vespa
# ------------------------------------------------------------
gunzip dump.json.gz
vespa-feed-client dump.json

# ------------------------------------------------------------
#  Done 🎉
# ------------------------------------------------------------
echo "✅ Vespa data restored successfully!"
