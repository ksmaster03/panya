# ถอดคำพูดจากไฟล์เสียงหรือวิดีโอด้วย faster-whisper (CPU) สำหรับ panya: POST /v1/files
#   python scripts/transcribe.py <file> [--model M] [--lang th]
# พิมพ์ JSON ทีละบรรทัด: {"duration": วินาที} ตามด้วย {"start", "end", "text"} ทีละช่วง
# ไม่แก้หรือสรุปคำ: ได้ข้อความตามที่พูด (อาจสะกดผิดบ้างตามความแม่นของโมเดล)
# ติดตั้ง: pip install faster-whisper · ถอดเสียงวิดีโอได้โดยไม่ต้องมี ffmpeg (ใช้ PyAV ที่มากับ faster-whisper)
import argparse, json, sys

ap = argparse.ArgumentParser()
ap.add_argument("file")
ap.add_argument("--model", default="mobiuslabsgmbh/faster-whisper-large-v3-turbo")
ap.add_argument("--lang", default=None)
a = ap.parse_args()

from faster_whisper import WhisperModel

model = WhisperModel(a.model, device="cpu", compute_type="int8")
# vad_filter: ข้ามช่วงเงียบ ลดคำมั่วที่โมเดลเดาออกมาในช่วงที่ไม่มีเสียงพูด
segments, info = model.transcribe(a.file, language=a.lang or None, vad_filter=True, beam_size=1)
print(json.dumps({"duration": info.duration, "language": info.language}), flush=True)
for s in segments:
    print(json.dumps({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}, ensure_ascii=False), flush=True)
