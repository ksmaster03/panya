#!/usr/bin/env bash
# จำนวนความจำที่ใช้ได้ต่อสมอง เป็น JSON {"brain": n} · ใช้เทียบหลังย้ายข้อมูล
set -euo pipefail
K="$(grep '^PANYA_API_KEYS=' /opt/panya/.env | cut -d= -f2- | cut -d, -f1)"
curl -fsS -H "authorization: Bearer $K" http://127.0.0.1:6800/v1/overview \
  | python3 -c 'import json,sys; print(json.dumps({b["brain"]: b["live"] for b in json.load(sys.stdin)["brains"]}))'
