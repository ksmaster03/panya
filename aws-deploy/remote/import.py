#!/usr/bin/env python3
# นำไฟล์ export ของ panya เข้าเซิร์ฟเวอร์ในเครื่องนี้ ทีละชุด (เซิร์ฟเวอร์รับได้ครั้งละไม่เกิน 5000)
# ใช้: import.py <export.json[.gz]> [brain]   · API key อ่านจาก /opt/panya/.env
import gzip, json, sys, time, urllib.request

path = sys.argv[1]
data = json.load(gzip.open(path, 'rt', encoding='utf-8') if path.endswith('.gz') else open(path, encoding='utf-8'))
brain = sys.argv[2] if len(sys.argv) > 2 else data['brain']
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
        except Exception as e:  # เซิร์ฟเวอร์อาจรีสตาร์ตระหว่างทาง รอแล้วลองใหม่
            print(f'  retry {attempt + 1}: {e}', flush=True)
            time.sleep(20)
    raise SystemExit('import failed')

t0 = time.time()
done = 0
for i in range(0, len(live), CHUNK):
    body = {'brain': brain, 'memories': live[i:i + CHUNK]}
    if i == 0:
        body['entities'] = data.get('entities', [])
    r = post(body)
    done += len(body['memories'])
    print(f'{brain}: {done}/{len(live)} (+{r.get("created", 0)} new, {r.get("merged", 0)} merged) {time.time() - t0:.0f}s', flush=True)
print(f'{brain}: imported {done} in {time.time() - t0:.0f}s')
