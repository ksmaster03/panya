#!/usr/bin/env bash
# build image arm64 จาก clone ที่สะอาด → ECR (tag = git sha, ห้ามทับ) → สั่งเครื่องดึงและรันผ่าน SSM
#   DEPLOY_DIR (ค่าเริ่มต้น D:/tmp/panya-deploy) ต้องเป็น clone ที่ไม่มีไฟล์แก้ค้าง
set -euo pipefail
source "$(dirname "$0")/00-vars.sh" "$@"
t() { aws_ "$@" | tr -d '\r'; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# รูปแบบ D:/... เพราะ MSYS_NO_PATHCONV=1 ทำให้ git.exe ไม่แปลง /d/... ให้
DEPLOY_DIR="${DEPLOY_DIR:-D:/tmp/panya-deploy}"
[ -z "$(git -C "$DEPLOY_DIR" status --porcelain)" ] || { echo "$DEPLOY_DIR has uncommitted changes"; exit 1; }
SHA="$(git -C "$DEPLOY_DIR" rev-parse --short=7 HEAD)"
REPO="$(out_get ecr_repo)"; BUCKET="$(out_get bucket)"; IID="$(out_get instance_id)"
[ -n "$REPO" ] && [ -n "$IID" ] || { echo "run 01-provision.sh first"; exit 1; }
IMAGE="$REPO:$SHA"
echo "deploy $SHA → $IID ($IMAGE)"

# ── image ────────────────────────────────────────────────────────────
if [ -n "$(t ecr describe-images --repository-name "$PROJECT" --image-ids imageTag="$SHA" --query 'imageDetails[0].imageTags[0]' --output text 2>/dev/null | grep -v None)" ]; then
  ok "image $SHA already in ECR"
else
  if ! docker image inspect "panya:$SHA-arm64" >/dev/null 2>&1; then
    (cd "$DEPLOY_DIR" && docker buildx build --platform linux/arm64 --provenance=false -t "panya:$SHA-arm64" --load .)
  fi
  if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] docker push $IMAGE"; else
    # token ของ ECR ยาวเกินที่ Windows Credential Manager รับ ("The stub received bad data")
    # จึง login และ push จาก container docker:cli ที่ใช้ Docker engine เดียวกัน (token อยู่แค่ใน container ที่ลบทิ้งทันที)
    docker tag "panya:$SHA-arm64" "$IMAGE"
    aws ecr get-login-password | tr -d '\r\n' | docker run --rm -i -v /var/run/docker.sock:/var/run/docker.sock docker:27-cli \
      sh -c "docker login --username AWS --password-stdin ${REPO%%/*} >/dev/null && docker push -q $IMAGE"
  fi
  ok "image pushed $IMAGE"
fi

# ── ชุดไฟล์ของเครื่อง ────────────────────────────────────────────────
tar -czf "$TMP/bundle.tgz" -C "$HERE/remote" docker-compose.yml Caddyfile render-env.sh backup.sh import.py counts.sh
t s3 cp --only-show-errors "$(winpath "$TMP/bundle.tgz")" "s3://$BUCKET/deploy/$SHA/bundle.tgz"
ok "bundle uploaded"

# ── สั่งเครื่อง ──────────────────────────────────────────────────────
python - "$(winpath "$TMP/cmd.json")" "$BUCKET" "$SHA" "$IMAGE" "$DOMAIN" "$AWS_REGION" "${REPO%%/*}" <<'PY'
import json, sys
out, bucket, sha, image, domain, region, registry = sys.argv[1:]
script = f"""set -euo pipefail
cd /opt/panya
aws s3 cp --only-show-errors s3://{bucket}/deploy/{sha}/bundle.tgz /tmp/panya-bundle.tgz
tar -xzf /tmp/panya-bundle.tgz -C /opt/panya && rm -f /tmp/panya-bundle.tgz
echo {bucket} > backup-bucket
bash render-env.sh {image} {domain} {region}
aws ecr get-login-password --region {region} | docker login --username AWS --password-stdin {registry} >/dev/null
docker compose pull -q
docker compose up -d --remove-orphans
docker compose restart caddy >/dev/null  # Caddyfile เป็นไฟล์ mount: compose ไม่รู้ว่าเปลี่ยน และ admin API ปิดอยู่จึง reload ไม่ได้
for i in $(seq 1 90); do curl -fsS http://127.0.0.1:6800/health >/dev/null 2>&1 && break; sleep 5; done
curl -fsS http://127.0.0.1:6800/health
echo
docker compose ps --format '{{{{.Service}}}} {{{{.Image}}}} {{{{.Status}}}}'
"""
json.dump({"commands": script.split("\n"), "executionTimeout": ["1800"]}, open(out, "w"))
PY
if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] ssm send-command (pull + compose up) to $IID"; exit 0; fi
CID="$(t ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript --comment "panya deploy $SHA" \
  --parameters "file://$(winpath "$TMP/cmd.json")" --cloud-watch-output-config CloudWatchOutputEnabled=true,CloudWatchLogGroupName="$(out_get log_group)" \
  --query Command.CommandId --output text)"
echo "  ssm command $CID"
while :; do
  sleep 10
  st="$(t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$st" in Pending|InProgress|Delayed) printf '.';; *) echo; break;; esac
done
t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text
if [ "$st" != Success ]; then
  t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text
  echo "deploy failed: $st"; exit 1
fi
out_set deployed_sha "$SHA"
ok "deployed $SHA"
