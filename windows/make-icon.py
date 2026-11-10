# สร้าง windows/panya.ico (ไอคอนแอป): python windows/make-icon.py
import os
from PIL import Image, ImageDraw

def draw(n):
    s = 4  # วาดใหญ่แล้วย่อให้ขอบเนียน
    im = Image.new('RGBA', (n * s, n * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w = n * s
    d.rounded_rectangle([0, 0, w - 1, w - 1], radius=int(w * 0.22), fill=(24, 24, 27, 255))
    # สามวงที่ซ้อนกัน: ปัญญา 3 (สุตะ จินตะ ภาวนา)
    r = w * 0.2
    pts = [(w * 0.5, w * 0.36), (w * 0.36, w * 0.6), (w * 0.64, w * 0.6)]
    cols = [(47, 98, 255, 235), (34, 211, 238, 235), (167, 139, 250, 235)]
    for (x, y), c in zip(pts, cols):
        layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse([x - r, y - r, x + r, y + r], fill=c)
        im = Image.alpha_composite(im, layer)
    return im.resize((n, n), Image.LANCZOS)

here = os.path.dirname(os.path.abspath(__file__))
big = draw(256)
big.save(os.path.join(here, 'panya.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
big.save(os.path.join(here, 'panya.png'))
print('ok')
