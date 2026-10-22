#!/usr/bin/env bash
# สำรองทุกสมองเป็นไฟล์ export (นำกลับด้วย POST /v1/import) ขึ้น S3 · รันทุกคืนด้วย systemd timer panya-backup
set -euo pipefail
cd /opt/panya
BUCKET="$(cat /opt/panya/backup-bucket)"
REGION="$(grep '^AWS_REGION=' .env | cut -d= -f2)"
KEY="$(grep '^PANYA_API_KEYS=' .env | cut -d= -f2- | tr ',' '\n' | grep -v '@' | head -n1)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

brains=$(curl -fsS -H "authorization: Bearer $KEY" http://127.0.0.1:6800/v1/overview | python3 -c 'import json,sys; print("\n".join(b["brain"] for b in json.load(sys.stdin)["brains"]))')
total=0
for b in $brains; do
  curl -fsS -H "authorization: Bearer $KEY" "http://127.0.0.1:6800/v1/export?brain=$b" | gzip -9 > "$DIR/$b.json.gz"
  n=$(gunzip -c "$DIR/$b.json.gz" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["memories"]))')
  total=$((total + n))
  echo "$b $n"
done
aws s3 cp --region "$REGION" --recursive --only-show-errors "$DIR" "s3://$BUCKET/backups/$STAMP/"
echo "backup $STAMP: $(echo $brains | wc -w) brains, $total memories → s3://$BUCKET/backups/$STAMP/"
