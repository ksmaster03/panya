#!/usr/bin/env bash
# เขียน /opt/panya/.env จาก SSM Parameter Store (สิทธิ์ 600) · รหัสลับไม่อยู่ในสคริปต์หรือ repo
# ใช้: render-env.sh <image> <domain> <region>
set -euo pipefail
IMAGE="$1"; DOMAIN="$2"; REGION="$3"
P=/panya/prod
get() { aws ssm get-parameter --region "$REGION" --with-decryption --name "$P/$1" --query Parameter.Value --output text; }

umask 077
tmp=$(mktemp /opt/panya/.env.XXXX)
{
  echo "PANYA_IMAGE=$IMAGE"
  echo "DOMAIN=$DOMAIN"
  echo "AWS_REGION=$REGION"
  # key ของทุกเครื่องลูกข่าย (/panya/prod/api_key/<เครื่อง>) รวมเป็นรายการเดียว
  keys=$(aws ssm get-parameters-by-path --region "$REGION" --with-decryption --path "$P/api_key" --query 'Parameters[].Value' --output text | tr '\t' ',')
  [ -n "$keys" ] || { echo "no API keys under $P/api_key"; exit 1; }
  echo "PANYA_API_KEYS=$keys"
  echo "PANYA_ADMIN_USER=$(get admin_user)"
  echo "PANYA_ADMIN_PASSWORD=$(get admin_password)"
} > "$tmp"
mv "$tmp" /opt/panya/.env
chmod 600 /opt/panya/.env
echo "env rendered for $IMAGE"
