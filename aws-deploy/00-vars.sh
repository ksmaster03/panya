#!/usr/bin/env bash
# ค่าร่วมของสคริปต์ deploy ทุกตัว · source ไฟล์นี้ ไม่ต้องรันเอง
# รันจาก Git Bash บน Windows ได้: aws.exe เป็นโปรแกรม Windows จึงต้องปิดการแปลง path ของ MSYS
# (ไม่งั้นชื่อ SSM parameter อย่าง /panya/prod/... จะกลายเป็น C:/Program Files/Git/panya/...)
export MSYS_NO_PATHCONV=1
export AWS_PROFILE="${AWS_PROFILE:-villapro}"
export AWS_REGION="${AWS_REGION:-ap-southeast-7}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""
export PYTHONIOENCODING=utf-8

PROJECT=panya
ENVIRONMENT=prod
DOMAIN="${DOMAIN:-panya.toptierdigital.space}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.medium}"
ARCH=arm64
ROOT_GB=40
ADMIN_USER="${ADMIN_USER:-kosin}"
SSM_PREFIX="/$PROJECT/$ENVIRONMENT"
NAME="$PROJECT-$ENVIRONMENT"
TAGS="Key=Project,Value=$PROJECT Key=Environment,Value=$ENVIRONMENT Key=ManagedBy,Value=aws-deploy-skill"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUTS="$HERE/outputs.json"
[ -f "$OUTPUTS" ] || echo '{}' > "$OUTPUTS"

DRY_RUN=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY_RUN=1; done

# aws.exe ต้องการ path แบบ Windows สำหรับ file:// และ fileb://
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

# ตัวเรียก AWS: โหมด --dry-run ยอมเฉพาะคำสั่งอ่านอย่างเดียว คำสั่งที่สร้าง/แก้/ลบจะพิมพ์ออกมาแทน
aws_() {
  local op="${2:-}"
  if [ "$DRY_RUN" = 1 ] && ! [[ "$op" =~ ^(describe|list|get|head|wait)- ]] && [ "$1 $op" != "sts get-caller-identity" ]; then
    echo "  [dry-run] aws $*" | sed -E 's/(--value) [^ ]+/\1 ****/' >&2
    return 0
  fi
  aws "$@"
}

out_get() { python -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$(winpath "$OUTPUTS")" "$1"; }
out_set() {
  [ "$DRY_RUN" = 1 ] && return 0
  python -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[sys.argv[2]]=sys.argv[3]; json.dump(d,open(p,'w'),indent=2)" "$(winpath "$OUTPUTS")" "$1" "$2"
}
ok() { echo "✓ $*"; }
