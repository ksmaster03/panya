#!/usr/bin/env bash
# ย้ายความจำจากเซิร์ฟเวอร์ในเครื่องนี้ขึ้นคลาวด์: export → S3 → เครื่องนำเข้าทีละชุด → เทียบจำนวนต่อสมอง
# embedding ถูกคำนวณใหม่บนเครื่องปลายทาง ใช้เวลาตามจำนวนความจำ (ราว 40,000 รายการ ≈ 30-90 นาที)
set -euo pipefail
source "$(dirname "$0")/00-vars.sh" "$@"
t() { aws_ "$@" | tr -d '\r'; }
REPO_ROOT="$(cd "$HERE/.." && pwd)"
BUCKET="$(out_get bucket)"; IID="$(out_get instance_id)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DIR="$HERE/.migrate/$STAMP"

(cd "$REPO_ROOT" && bun aws-deploy/export-local.ts "$(winpath "$DIR")")
t s3 cp --recursive --only-show-errors "$(winpath "$DIR")" "s3://$BUCKET/migrate/$STAMP/"
ok "exports uploaded to s3://$BUCKET/migrate/$STAMP/"
[ "$DRY_RUN" = 1 ] && exit 0

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
python - "$(winpath "$TMP/cmd.json")" "$BUCKET" "$STAMP" "$AWS_REGION" <<'PY'
import json, sys
out, bucket, stamp, region = sys.argv[1:]
script = f"""set -euo pipefail
D=/opt/panya/migrate/{stamp}
mkdir -p $D
aws s3 cp --region {region} --recursive --only-show-errors s3://{bucket}/migrate/{stamp}/ $D/
# สมองเล็กก่อน ให้เห็นผลเร็ว
for f in $(ls -S -r $D/*.json.gz); do python3 /opt/panya/import.py $f; done
rm -rf $D
"""
json.dump({"commands": script.split("\n"), "executionTimeout": ["14400"]}, open(out, "w"))
PY
CID="$(t ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript --comment "panya migrate $STAMP" --timeout-seconds 600 \
  --parameters "file://$(winpath "$TMP/cmd.json")" --cloud-watch-output-config CloudWatchOutputEnabled=true,CloudWatchLogGroupName="$(out_get log_group)" \
  --query Command.CommandId --output text)"
out_set migrate_command "$CID"
echo "  ssm command $CID (progress: aws logs tail $(out_get log_group) --follow --since 10m)"
while :; do
  sleep 30
  st="$(t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$st" in Pending|InProgress|Delayed) printf '.';; *) echo; break;; esac
done
t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text | grep -E 'imported|retry' || true
[ "$st" = Success ] || { t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text; echo "migrate failed: $st"; exit 1; }

# ── เทียบจำนวน ───────────────────────────────────────────────────────
CID="$(t ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters 'commands=["bash /opt/panya/counts.sh"]' \
  --query Command.CommandId --output text)"
sleep 8
CLOUD="$(t ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text)"
python - "$(winpath "$DIR/counts.json")" "$CLOUD" <<'PY'
import json, sys
local = json.load(open(sys.argv[1])); cloud = json.loads(sys.argv[2])
bad = 0
for b, n in sorted(local.items()):
    c = cloud.get(b, 0); mark = 'OK ' if c == n else 'DIFF'
    bad += c != n
    print(f'{mark} {b:24} local {n:>7}  cloud {c:>7}')
print('all brains match' if not bad else f'{bad} brain(s) differ (duplicates inside a brain merge on import, so cloud can be slightly lower)')
PY
