#!/usr/bin/env bash
# ลบทรัพยากรของ panya บน AWS ทั้งหมด (ย้อนลำดับของ 01-provision.sh) · ข้อมูลบนเครื่องหายถาวร
# ต้องพิมพ์ชื่อโปรเจกต์ยืนยัน · bucket S3 (สำรองข้อมูล) ลบเฉพาะเมื่อใส่ --delete-backups
set -euo pipefail
source "$(dirname "$0")/00-vars.sh" "$@"
t() { aws_ "$@" | tr -d '\r'; }
DELETE_BACKUPS=0; for a in "$@"; do [ "$a" = "--delete-backups" ] && DELETE_BACKUPS=1; done
ACCOUNT="$(t sts get-caller-identity --query Account --output text)"
read -r -p "type '$NAME' to delete panya from account $ACCOUNT ($AWS_REGION): " answer
[ "$answer" = "$NAME" ] || { echo "cancelled"; exit 1; }

IID="$(t ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)"
ALLOC="$(t ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].AllocationId' --output text)"
if [ -n "$ALLOC" ] && [ "$ALLOC" != None ]; then
  ASSOC="$(t ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].AssociationId' --output text)"
  [ "$ASSOC" = None ] || t ec2 disassociate-address --association-id "$ASSOC"
  t ec2 release-address --allocation-id "$ALLOC"; ok "Elastic IP released"
fi
if [ -n "$IID" ] && [ "$IID" != None ]; then
  t ec2 terminate-instances --instance-ids "$IID" >/dev/null
  [ "$DRY_RUN" = 1 ] || t ec2 wait instance-terminated --instance-ids "$IID"; ok "instance $IID terminated"
fi
POL="$(t dlm get-lifecycle-policies --target-tags "Snapshot=$NAME" --query 'Policies[0].PolicyId' --output text 2>/dev/null || true)"
[ -z "$POL" ] || [ "$POL" = None ] || { t dlm delete-lifecycle-policy --policy-id "$POL"; ok "DLM policy deleted (existing snapshots kept)"; }
SG="$(t ec2 describe-security-groups --filters Name=group-name,Values="$NAME-sg" --query 'SecurityGroups[0].GroupId' --output text)"
[ "$SG" = None ] || [ -z "$SG" ] || { t ec2 delete-security-group --group-id "$SG"; ok "security group deleted"; }
ROLE="$NAME-ec2"
if t iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  t iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" || true
  t iam delete-instance-profile --instance-profile-name "$ROLE"
fi
if t iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  t iam delete-role-policy --role-name "$ROLE" --policy-name "$NAME-access" || true
  t iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore || true
  t iam delete-role --role-name "$ROLE"; ok "IAM role deleted"
fi
for p in $(t ssm get-parameters-by-path --path "$SSM_PREFIX" --recursive --query 'Parameters[].Name' --output text); do t ssm delete-parameter --name "$p"; done
ok "SSM parameters deleted"
t ecr delete-repository --repository-name "$PROJECT" --force >/dev/null 2>&1 && ok "ECR deleted" || true
t logs delete-log-group --log-group-name "/$PROJECT/$ENVIRONMENT" 2>/dev/null && ok "log group deleted" || true
if [ "$DELETE_BACKUPS" = 1 ]; then
  t s3 rb "s3://$PROJECT-$ACCOUNT" --force && ok "S3 bucket deleted"
else
  echo "kept s3://$PROJECT-$ACCOUNT (backups). Add --delete-backups to remove it."
fi
echo '{}' > "$OUTPUTS"
