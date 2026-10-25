#!/bin/bash
# EC2 user-data (Amazon Linux 2023 arm64): Docker + compose, swap, automatic security updates, nightly backup timer.
# Kept ASCII-only: aws.exe on Windows decodes user-data with the local codepage.
set -euxo pipefail
exec > >(tee -a /var/log/panya-setup.log) 2>&1

dnf install -y docker dnf-automatic python3
systemctl enable --now docker

# docker compose plugin (not packaged in AL2023), checksum verified
COMPOSE_VERSION=v2.29.7
mkdir -p /usr/local/lib/docker/cli-plugins
cd /tmp
curl -fsSLo docker-compose "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64"
curl -fsSLo docker-compose.sha256 "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64.sha256"
echo "$(cut -d' ' -f1 docker-compose.sha256)  docker-compose" | sha256sum -c -
install -m 0755 docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

# 2 GB swap as a safety net for embedding bursts on a 4 GB host
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/90-panya.conf

# security updates only, applied automatically, no automatic reboot
sed -i 's/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

mkdir -p /opt/panya
chmod 750 /opt/panya

cat > /etc/systemd/system/panya-backup.service <<'UNIT'
[Unit]
Description=panya nightly export to S3
After=docker.service
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/panya/backup.sh
UNIT
cat > /etc/systemd/system/panya-backup.timer <<'UNIT'
[Unit]
Description=panya nightly export to S3 (02:30 Bangkok)
[Timer]
OnCalendar=*-*-* 02:30:00 Asia/Bangkok
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable panya-backup.timer

touch /var/lib/panya-setup-done
