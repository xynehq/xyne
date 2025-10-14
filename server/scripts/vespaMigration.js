/* #!/bin/bash

// ------------------------------------------------------------
//  STEP 1: Start Vespa container for dump creation
// ------------------------------------------------------------

//docker run -d --name vespa-testing \
//-e VESPA_IGNORE_NOT_ENOUGH_MEMORY=true \
//-p 8181:8080 \
//-p 19171:19071 \
//-p 2224:22 \
//vespaengine/vespa:latest

// ------------------------------------------------------------
//  STEP 2: Export Vespa data
// ------------------------------------------------------------

"vespa visit --content-cluster my_content --make-feed > dump.json"

// ------------------------------------------------------------
//  STEP 3: Compress dump file
// ------------------------------------------------------------

"apt install -y pigz"
//# or yum install pigz

// pigz is parallel gzip (much faster)
// pigz -9 (1.15 hr, ~280 GB) or -7 (1 hr, ~320 GB)
"pigz -9 dump.json"
// creates dump.json.gz

// if pigz is not available, fallback to gzip
//gzip -9 dump.json
//(gzip -9 -c dump.json > dump.json.gz)

// ------------------------------------------------------------
//  STEP 4: Encrypt dump file (OpenSSL password-based)
// ------------------------------------------------------------

"openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in dump.json.gz \
  -out dump.json.gz.enc"

// Strong AES-256 encryption, password will be prompted
// dump.json.gz.enc → safe to transfer/upload

// ------------------------------------------------------------
//  OPTIONAL: GPG-based encryption (if using keypair)
// ------------------------------------------------------------

//gpg --full-generate-key
//gpg --list-keys
//gpg --output dump.json.gz.gpg --encrypt --recipient <A1B2C3D4E5F6G7H8> dump.json.gz

// ------------------------------------------------------------
//  STEP 5: Set up SSH access for container-to-host transfer
// ------------------------------------------------------------

// ssh-keygen -t rsa -b 4096 -C "mohd.shoaib@juspay.in"
// cat ~/.ssh/id_rsa.pub

// On your **remote machine (container)**:
//docker exec -it --user root vespa-testing /bin/bash

//apt-get or yum update
//apt-get or yum install -y openssh-client (openssh first)
//ssh-keygen -A
//yum install -y openssh-server
//mkdir -p /var/run/sshd
///usr/sbin/sshd

//mkdir -p ~/.ssh
//chmod 700 ~/.ssh
//echo "PASTE_YOUR_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
//chmod 600 ~/.ssh/authorized_keys

//yum install -y rsync

// ------------------------------------------------------------
//  STEP 6: Test SSH + Transfer dump or key
// ------------------------------------------------------------

//ssh -p 2224 root@192.168.1.6 - testing

//yum install -y rsync

//gpg --export-secret-keys --armor BF4AF7E7E3955EF3A436A4ED7C59556BFC58DFAF  > my-private-key.asc

//rsync -avzP --inplace --partial --append -e "ssh -p 2224" my-private-key.asc  root@192.168.1.6:/home/

"brew install awscli"

"aws configure"

"AWS Access Key ID [None]: ****************"
"AWS Secret Access Key [None]: ********************"
"Default region name [None]: ap-south-1"
"Default output format [None]: json"

//AWS Access Key ID [None]: AKIAIOSFODNN7EXAMPLE
//AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
//Default region name [None]: ap-south-1
//Default output format [None]: json


// For fast file transfer
"aws configure set default.s3.max_concurrent_requests 20"
"aws configure set default.s3.multipart_threshold 64MB"
//Check your identity:
"aws sts get-caller-identity"

// for Making transfers faster (optional)
"aws configure set default.s3.multipart_chunksize 64MB"
"aws configure set default.s3.max_queue_size 100"
"aws configure set default.s3.multipart_upload_threshold 64MB"
"aws configure set default.s3.multipart_max_attempts 5"

"aws s3 cp dump.json.gz.enc s3://your-bucket-name/dumps/"

//Optional (show progress bar):
"aws s3 cp dump.json.gz.enc s3://xyne-vespa-backups/2025-10-13/ --expected-size $(stat -c%s dump.json.gz.enc"

//rsync -avzP --inplace --partial --append -e "ssh -p 2224" dump.json.gz.gpg root@192.168.1.6:/home/root/

// ------------------------------------------------------------
//  STEP 7: On the new machine
// ------------------------------------------------------------

// Option 1 — using AWS S3
"aws s3 cp s3://your-bucket-name/dumps/dump.json.gz.enc "

"openssl enc -d -aes-256-cbc -pbkdf2 -salt \
  -in dump.json.gz.enc \
  -out dump.json.gz"

// Option 2 — if using GPG
//yum install -y pinentry
//gpgconf --kill gpg-agent
//export GPG_TTY=$(tty)
//echo $GPG_TTY

//gpg --import my-private-key.asc
//gpg --list-secret-keys
//gpg --output dump.json.gz --decrypt dump.json.gz.gpg

// ------------------------------------------------------------
//  STEP 8: Decompress and feed into Vespa
// ------------------------------------------------------------

"gunzip dump.json.gz"

"vespa-feed-client dump.json"

// ------------------------------------------------------------
//  Done 🎉
// ------------------------------------------------------------
*/
