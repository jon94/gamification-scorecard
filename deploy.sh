#!/bin/bash
# deploy.sh — push local changes to the GCP VM and restart the server
#
# Usage:
#   ./deploy.sh                    # deploy code changes only
#   ./deploy.sh --refresh-data     # also re-run refresh.js on the VM after deploy
#
# Configure these three variables before first use:
GCP_USER="your-username"           # your GCP SSH username (usually your google account prefix)
GCP_IP="your-vm-external-ip"       # External IP of your GCP VM
REMOTE_DIR="/home/$GCP_USER/adoption-scorecard"

set -e

echo "🚀 Deploying Datadog Adoption Scorecard to $GCP_IP…"

# Sync all files except secrets and generated outputs
rsync -avz --progress \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='data.js' \
  --exclude='evidence.json' \
  --exclude='logs/' \
  --exclude='.DS_Store' \
  ./ "$GCP_USER@$GCP_IP:$REMOTE_DIR/"

echo "📦 Installing dependencies…"
ssh "$GCP_USER@$GCP_IP" "cd $REMOTE_DIR && npm install --production"

if [[ "$1" == "--refresh-data" ]]; then
  echo "🔄 Running refresh.js on VM to pull fresh Datadog data…"
  ssh "$GCP_USER@$GCP_IP" "cd $REMOTE_DIR && node refresh.js"
fi

echo "🔁 Restarting PM2 process…"
ssh "$GCP_USER@$GCP_IP" "cd $REMOTE_DIR && pm2 restart scorecard || pm2 start ecosystem.config.js"

echo "✅ Deploy complete. App is live at http://$GCP_IP:3000"
