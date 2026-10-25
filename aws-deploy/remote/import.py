#!/usr/bin/env python3
# นำไฟล์ export ของ panya เข้าเซิร์ฟเวอร์ในเครื่องนี้ ทีละชุด (เซิร์ฟเวอร์รับได้ครั้งละไม่เกิน 5000)
# ใช้: import.py <export.json[.gz]> [brain]   · API key อ่านจาก /opt/panya/.env
import gzip, json, re, sys, time, urllib.error, urllib.request

path = sys.argv[1]
data = json.load(gzip.open(path, 'rt', encoding='utf-8') if path.endswith('.gz') else open(path, encoding='utf-8'))
brain = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != '-' else data['brain']
# ลำดับที่เริ่ม ใช้ทำต่อหลังหมดเวลากลางทาง (รายการที่เคยเข้าแล้วจะ merge ไม่ซ้ำ)
start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
env = dict(l.rstrip('\n').split('=', 1) for l in open('/opt/panya/.env') if '=' in l)
key = next(k for k in env['PANYA_API_KEYS'].split(',') if '@' not in k)
live = [m for m in data['memories'] if m.get('active', True) is not False]
CHUNK = 1000

def post(body):
    for attempt in range(5):
        try:
            req = urllib.request.Request('http://127.0.0.1:6800/v1/import', data=json.dumps(body).encode(), method='POST',
                                         headers={'content-type': 'application/json', 'authorization': 'Bearer ' + key})
            return json.load(urllib.request.urlopen(req, timeout=1800))
        except urllib.error.HTTPError as e:  # 4xx = ข้อมูลผิด ลองซ้ำไม่ช่วย
            if e.code < 500: raise SystemExit(f'{brain}: HTTP {e.code} {e.read().decode(errors="replace")[:300]}')
            print(f'  retry {attempt + 1}: {e}', flush=True); time.sleep(20)
        except Exception as e:  # เซิร์ฟเวอร์อาจรีสตาร์ตระหว่างทาง รอแล้วลองใหม่
            print(f'  retry {attempt + 1}: {e}', flush=True)
            time.sleep(20)
    raise SystemExit('import failed')

# ชื่อเฉพาะที่ผิดรูปแบบ (บันทึกไว้ก่อนเซิร์ฟเวอร์ตรวจเข้ม) จะทำให้ทั้งชุดถูกปฏิเสธ จึงข้ามและแจ้งไว้
TYPE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
ok_str = lambda v: isinstance(v, list) and all(isinstance(x, str) and x.strip() and len(x) <= 191 for x in v)
entities = [e for e in data.get('entities', []) if TYPE.match(e.get('type', '')) and ok_str(e.get('cues', [])) and ok_str(e.get('names', []))]
for e in data.get('entities', []):
    if e not in entities: print(f'{brain}: skipped invalid entity type {e.get("type")!r}', flush=True)

# นำเข้าครบแล้ว (รันซ้ำหลังล้มกลางทาง) ไม่ต้องทำอีก ไม่งั้นรายการจะถูกนับซ้ำเป็น merge
req = urllib.request.Request('http://127.0.0.1:6800/v1/overview', headers={'authorization': 'Bearer ' + key})
for attempt in range(10):  # เซิร์ฟเวอร์อาจยังคำนวณชุดก่อนหน้าค้างอยู่ จึงยังไม่ตอบ
    try:
        have = {b['brain']: b['live'] for b in json.load(urllib.request.urlopen(req, timeout=120))['brains']}
        break
    except Exception as e:
        print(f'  overview retry {attempt + 1}: {e}', flush=True); time.sleep(30)
else:
    raise SystemExit('server did not answer /v1/overview')
if have.get(brain, 0) >= len(live) and not start:
    print(f'{brain}: already has {have[brain]} of {len(live)}, skipped')
    sys.exit(0)

t0 = time.time()
done = start
for i in range(start, len(live), CHUNK):
    body = {'brain': brain, 'memories': live[i:i + CHUNK]}
    if i == 0:
        body['entities'] = entities
    r = post(body)
    done += len(body['memories'])
    print(f'{brain}: {done}/{len(live)} (+{r.get("created", 0)} new, {r.get("merged", 0)} merged) {time.time() - t0:.0f}s', flush=True)
print(f'{brain}: imported {done} in {time.time() - t0:.0f}s')
