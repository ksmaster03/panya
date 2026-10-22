#!/usr/bin/env bash
# สร้างทรัพยากรทั้งหมดของ panya บน AWS · รันซ้ำได้ (มีอยู่แล้วจะข้าม) · ลองก่อนด้วย --dry-run
#   ECR · S3 (สำรองข้อมูล/ชุด deploy) · CloudWatch Logs · SSM (key/รหัสผ่าน) · IAM role · Security group (เฉพาะ Cloudflare)
#   DLM snapshot รายวัน 7 วัน · EC2 t4g.medium + Elastic IP · เข้าเครื่องผ่าน SSM เท่านั้น ไม่มี SSH
set -euo pipefail
source "$(dirname "$0")/00-vars.sh" "$@"
t() { aws_ "$@" | tr -d '\r'; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
w() { winpath "$TMP/$1"; }

ACCOUNT="$(t sts get-caller-identity --query Account --output text)"
echo "account $ACCOUNT · profile $AWS_PROFILE · region $AWS_REGION · dry-run=$DRY_RUN"
BUCKET="$PROJECT-$ACCOUNT"
REPO_ARN="arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/$PROJECT"
LOG_GROUP="/$PROJECT/$ENVIRONMENT"
ROLE="$NAME-ec2"

# ── ECR ──────────────────────────────────────────────────────────────
if t ecr describe-repositories --repository-names "$PROJECT" >/dev/null 2>&1; then ok "ECR $PROJECT exists"; else
  t ecr create-repository --repository-name "$PROJECT" --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 --tags $TAGS >/dev/null
  cat > "$TMP/lc.json" <<'J'
{"rules":[{"rulePriority":1,"description":"keep last 10 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}
J
  t ecr put-lifecycle-policy --repository-name "$PROJECT" --lifecycle-policy-text "file://$(w lc.json)" >/dev/null
  ok "ECR $PROJECT created"
fi
out_set ecr_repo "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/$PROJECT"

# ── S3 ───────────────────────────────────────────────────────────────
if t s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then ok "S3 $BUCKET exists"; else
  t s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  t s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  t s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  cat > "$TMP/s3lc.json" <<'J'
{"Rules":[
 {"ID":"backups-30d","Filter":{"Prefix":"backups/"},"Status":"Enabled","Expiration":{"Days":30}},
 {"ID":"deploy-30d","Filter":{"Prefix":"deploy/"},"Status":"Enabled","Expiration":{"Days":30}},
 {"ID":"migrate-14d","Filter":{"Prefix":"migrate/"},"Status":"Enabled","Expiration":{"Days":14}}]}
J
  t s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "file://$(w s3lc.json)"
  t s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=Project,Value=$PROJECT},{Key=Environment,Value=$ENVIRONMENT},{Key=ManagedBy,Value=aws-deploy-skill}]"
  ok "S3 $BUCKET created (private, AES256, backups kept 30 days)"
fi
out_set bucket "$BUCKET"

# ── CloudWatch Logs ──────────────────────────────────────────────────
if [ -n "$(t logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "logGroups[?logGroupName=='$LOG_GROUP'].logGroupName" --output text)" ]; then ok "log group $LOG_GROUP exists"; else
  t logs create-log-group --log-group-name "$LOG_GROUP" --tags "Project=$PROJECT,Environment=$ENVIRONMENT,ManagedBy=aws-deploy-skill"
  t logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30
  ok "log group $LOG_GROUP created (30 days)"
fi
out_set log_group "$LOG_GROUP"

# ── SSM Parameter Store: สร้างครั้งเดียว ไม่ทับค่าที่มีอยู่ ──────────────
gen() { python -c "import secrets,sys; a='abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; print(''.join(secrets.choice(a) for _ in range(int(sys.argv[1]))))" "$1"; }
put_once() { # name type value
  if t ssm get-parameter --name "$SSM_PREFIX/$1" --query Parameter.Name --output text >/dev/null 2>&1; then ok "SSM $SSM_PREFIX/$1 exists"; else
    t ssm put-parameter --name "$SSM_PREFIX/$1" --type "$2" --value "$3" --tags $TAGS >/dev/null
    ok "SSM $SSM_PREFIX/$1 created ($2)"
  fi
}
put_once admin_user String "$ADMIN_USER"
put_once admin_password SecureString "$(gen 24)"
# API key แยกต่อเครื่องลูกข่าย ยกเลิกทีละเครื่องได้ด้วยการลบ parameter แล้ว deploy ใหม่
put_once api_key/desktop-h26bl86 SecureString "pk_$(gen 40)"
put_once api_key/tinv-026 SecureString "pk_$(gen 40)"

# ── IAM role ของเครื่อง ───────────────────────────────────────────────
if t iam get-role --role-name "$ROLE" >/dev/null 2>&1; then ok "IAM role $ROLE exists"; else
  cat > "$TMP/trust.json" <<'J'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
J
  t iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$(w trust.json)" --tags $TAGS >/dev/null
  t iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  ok "IAM role $ROLE created"
fi
cat > "$TMP/access.json" <<J
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
 {"Effect":"Allow","Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability"],"Resource":"$REPO_ARN"},
 {"Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParametersByPath"],"Resource":["arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter$SSM_PREFIX","arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter$SSM_PREFIX/*"]},
 {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$BUCKET"},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::$BUCKET/*"},
 {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams"],"Resource":"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:$LOG_GROUP:*"}]}
J
t iam put-role-policy --role-name "$ROLE" --policy-name "$NAME-access" --policy-document "file://$(w access.json)"
if t iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then ok "instance profile $ROLE exists"; else
  t iam create-instance-profile --instance-profile-name "$ROLE" --tags $TAGS >/dev/null
  t iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  ok "instance profile $ROLE created"
  [ "$DRY_RUN" = 1 ] || sleep 15 # IAM ใช้เวลากระจายค่าก่อน EC2 จะเห็น profile
fi

# ── Security group: 80/443 จาก Cloudflare เท่านั้น ───────────────────
VPC="$(t ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$(t ec2 describe-security-groups --filters Name=group-name,Values="$NAME-sg" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)"
if [ -n "$SG" ] && [ "$SG" != "None" ]; then ok "security group $SG exists"; else
  CF="$(curl -fsS https://www.cloudflare.com/ips-v4 | tr -d '\r')"
  echo "$CF" | grep -Eqv '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' && { echo "unexpected Cloudflare IP list"; exit 1; }
  SG="$(t ec2 create-security-group --group-name "$NAME-sg" --description "panya: HTTP/HTTPS from Cloudflare only, no SSH" --vpc-id "$VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$NAME-sg},{Key=Project,Value=$PROJECT},{Key=Environment,Value=$ENVIRONMENT},{Key=ManagedBy,Value=aws-deploy-skill}]" \
    --query GroupId --output text)"
  ranges="$(echo "$CF" | sed 's#.*#{"CidrIp":"&","Description":"cloudflare"}#' | paste -sd, -)"
  echo "[{\"IpProtocol\":\"tcp\",\"FromPort\":80,\"ToPort\":80,\"IpRanges\":[$ranges]},{\"IpProtocol\":\"tcp\",\"FromPort\":443,\"ToPort\":443,\"IpRanges\":[$ranges]}]" > "$TMP/ingress.json"
  t ec2 authorize-security-group-ingress --group-id "${SG:-sg-dryrun}" --ip-permissions "file://$(w ingress.json)" >/dev/null
  ok "security group ${SG:-<new>} created ($(echo "$CF" | wc -l) Cloudflare ranges)"
fi
out_set security_group "$SG"

# ── DLM: snapshot ดิสก์ทุกวัน เก็บ 7 วัน ─────────────────────────────
if [ -n "$(t dlm get-lifecycle-policies --target-tags "Snapshot=$NAME" --query 'Policies[0].PolicyId' --output text 2>/dev/null | grep -v None)" ]; then ok "DLM policy exists"; else
  t dlm create-default-role --resource-type snapshot >/dev/null 2>&1 || true
  cat > "$TMP/dlm.json" <<J
{"ResourceTypes":["VOLUME"],"TargetTags":[{"Key":"Snapshot","Value":"$NAME"}],
 "Schedules":[{"Name":"daily-7","CopyTags":true,"CreateRule":{"Interval":24,"IntervalUnit":"HOURS","Times":["19:00"]},"RetainRule":{"Count":7}}]}
J
  t dlm create-lifecycle-policy --description "$NAME daily snapshots keep 7" --state ENABLED \
    --execution-role-arn "arn:aws:iam::$ACCOUNT:role/AWSDataLifecycleManagerDefaultRole" \
    --policy-details "file://$(w dlm.json)" --tags "Project=$PROJECT,Environment=$ENVIRONMENT,ManagedBy=aws-deploy-skill" >/dev/null
  ok "DLM daily snapshot policy created (02:00 Bangkok, keep 7)"
fi

# ── EC2 ──────────────────────────────────────────────────────────────
IID="$(t ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [ -n "$IID" ] && [ "$IID" != "None" ]; then ok "instance $IID exists"; else
  AMI="$(t ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-$ARCH --query Parameter.Value --output text)"
  AZS="$(t ec2 describe-instance-type-offerings --location-type availability-zone --filters Name=instance-type,Values="$INSTANCE_TYPE" --query 'InstanceTypeOfferings[].Location' --output text)"
  SUBNET=""
  for az in $AZS; do
    s="$(t ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=availability-zone,Values="$az" Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)"
    if [ -n "$s" ] && [ "$s" != "None" ]; then SUBNET="$s"; break; fi
  done
  [ -n "$SUBNET" ] || [ "$DRY_RUN" = 1 ] || { echo "no default subnet offers $INSTANCE_TYPE"; exit 1; }
  echo "  AMI $AMI · subnet $SUBNET"
  cat > "$TMP/bdm.json" <<J
[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":$ROOT_GB,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":true}}]
J
  base="{Key=Project,Value=$PROJECT},{Key=Environment,Value=$ENVIRONMENT},{Key=ManagedBy,Value=aws-deploy-skill}"
  for attempt in 1 2 3 4 5; do
    if IID="$(t ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --subnet-id "$SUBNET" --security-group-ids "$SG" \
        --iam-instance-profile "Name=$ROLE" --block-device-mappings "file://$(w bdm.json)" \
        --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
        --credit-specification CpuCredits=unlimited --user-data "fileb://$(winpath "$HERE/remote/host-setup.sh")" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},$base]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME-root},{Key=Snapshot,Value=$NAME},$base]" \
        --query 'Instances[0].InstanceId' --output text)"; then break; fi
    echo "  run-instances failed (attempt $attempt), IAM may still be propagating"; sleep 15
  done
  [ "$DRY_RUN" = 1 ] || t ec2 wait instance-running --instance-ids "$IID"
  ok "instance ${IID:-<new>} running ($INSTANCE_TYPE)"
fi
out_set instance_id "$IID"

# ── Elastic IP ───────────────────────────────────────────────────────
EIP="$(t ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].[AllocationId,PublicIp,InstanceId]' --output text)"
if [ -n "$EIP" ] && [ "$EIP" != "None" ] && [ "$(echo "$EIP" | cut -f1)" != "None" ]; then
  ALLOC="$(echo "$EIP" | cut -f1)"; IP="$(echo "$EIP" | cut -f2)"; ok "Elastic IP $IP exists"
else
  read -r ALLOC IP < <(t ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=$PROJECT},{Key=Environment,Value=$ENVIRONMENT},{Key=ManagedBy,Value=aws-deploy-skill}]" --query '[AllocationId,PublicIp]' --output text) || true
  ok "Elastic IP ${IP:-<new>} allocated"
fi
if [ "$DRY_RUN" = 0 ] && [ "$(echo "$EIP" | cut -f3)" != "$IID" ]; then
  t ec2 associate-address --allocation-id "$ALLOC" --instance-id "$IID" >/dev/null
  ok "Elastic IP $IP → $IID"
fi
out_set eip_allocation "${ALLOC:-}"
out_set public_ip "${IP:-}"

# ── รอให้เครื่องพร้อม (SSM online + user-data เสร็จ) ─────────────────
if [ "$DRY_RUN" = 0 ]; then
  echo "  waiting for SSM agent and host setup (2-6 minutes)…"
  for i in $(seq 1 60); do
    st="$(t ssm describe-instance-information --filters Key=InstanceIds,Values="$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    [ "$st" = "Online" ] && break; sleep 10
  done
  [ "$st" = "Online" ] || { echo "SSM agent not online yet"; exit 1; }
  for i in $(seq 1 40); do
    cid="$(t ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript --parameters 'commands=["test -f /var/lib/panya-setup-done && docker compose version"]' --query Command.CommandId --output text)"
    sleep 8
    res="$(t ssm get-command-invocation --command-id "$cid" --instance-id "$IID" --query '[Status,StandardOutputContent]' --output text 2>/dev/null || true)"
    if [[ "$res" == Success* ]]; then ok "host ready: $(echo "$res" | cut -f2 | head -n1)"; break; fi
    sleep 7
  done
fi

echo
echo "next: bash aws-deploy/02-deploy.sh   ·   DNS: A ${DOMAIN%%.*} → ${IP:-<eip>} (Proxied) in Cloudflare"
