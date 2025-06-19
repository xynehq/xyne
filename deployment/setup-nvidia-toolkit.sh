#!/bin/bash

# Script to install NVIDIA Container Toolkit on a Debian-based host system (e.g., Ubuntu).

# Pre-flight check for required commands
REQUIRED_CMDS=("curl" "gpg")
for cmd in "${REQUIRED_CMDS[@]}"; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: Required command '$cmd' not found. Please install it and try again."
        exit 1
    fi
done
echo "All required commands (curl, gpg) are available."
echo ""
# This script requires sudo privileges to run.

echo "Starting NVIDIA Container Toolkit installation..."

# Check if running as root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script with sudo or as root."
  exit 1
fi

echo "Step 1: Adding NVIDIA GPG key and repository..."
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
if [ $? -ne 0 ]; then echo "Failed to download or dearmor GPG key. Exiting."; exit 1; fi

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
if [ $? -ne 0 ]; then echo "Failed to setup NVIDIA repository list. Exiting."; exit 1; fi

echo "Step 2: Updating package list..."
apt update
if [ $? -ne 0 ]; then echo "apt update failed. Exiting."; exit 1; fi

echo "Step 3: Installing nvidia-container-toolkit..."
apt install -y nvidia-container-toolkit
if [ $? -ne 0 ]; then echo "Failed to install nvidia-container-toolkit. Exiting."; exit 1; fi

echo "Step 4: Configuring NVIDIA Container Toolkit for Docker..."
nvidia-ctk runtime configure --runtime=docker
if [ $? -ne 0 ]; then echo "nvidia-ctk runtime configure failed. Exiting."; exit 1; fi

echo "Step 5: Restarting Docker service..."
systemctl restart docker
if [ $? -ne 0 ]; then echo "Failed to restart Docker service. Please check manually. Exiting."; exit 1; fi

echo ""
echo "NVIDIA Container Toolkit installation and Docker restart completed successfully."
echo "You should now be able to use GPUs with Docker containers."
echo "Verify by running a CUDA container, e.g.: sudo docker run --rm --gpus all nvidia/cuda:11.0.3-base-ubuntu20.04 nvidia-smi"

exit 0
