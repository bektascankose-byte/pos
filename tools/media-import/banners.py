"""
Web-sized artwork for the home page, from the manufacturers' key visuals.

Two sizes per banner: a wide one for a desktop hero and a taller crop for a
phone, because a 21:9 key visual scaled to a phone's width is a letterbox strip
with unreadable type. Both are JPEG -- these are photographs, and PNG would be
several times the size for no visible gain.
"""
import os, json
from PIL import Image

ROOT = os.path.expanduser('~/mnt/pos')
MK = os.path.join(ROOT, 'marketing')
OUT = os.path.join(ROOT, '.media-work', 'banners')
os.makedirs(OUT, exist_ok=True)

WIDE = (1920, 760)     # desktop hero
TALL = (900, 1100)     # phone hero
FEATURE = (1280, 720)  # 16:9 card

def cover(src, size, dest, quality=82):
    """Scale to fill and centre-crop, the way object-cover would."""
    with Image.open(src) as img:
        img.load()
        img = img.convert('RGB')
        tw, th = size
        scale = max(tw / img.width, th / img.height)
        w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
        img = img.resize((w, h), Image.LANCZOS)
        left, top = (w - tw) // 2, (h - th) // 2
        img.crop((left, top, left + tw, top + th)).save(
            dest, 'JPEG', quality=quality, optimize=True, progressive=True)
    return os.path.getsize(dest)

JOBS = [
  { 'name': 'geekbar-pulse-x-hero',
    'src': os.path.join(MK, 'Geek Bar Pulse', 'kv', 'Pulsex-kv-A4-horizon-rgb.jpg'),
    'sizes': [('image', WIDE), ('mobile_image', TALL)] },
  { 'name': 'foger-switchpro-feature',
    'src': os.path.join(MK, 'Foger Switch Pro Pods',
                        'Foger Switch Pro Disposable Pod Media Kit New',
                        'Foger Switch Pro Disposable Pod Media Kit New',
                        '3. Poster', 'Banner 1.jpg'),
    'sizes': [('image', FEATURE)] },
  { 'name': 'geekbar-mate-feature',
    'src': os.path.join(MK, 'GEEKBAR MATE 60K', 'Key Visual', 'GEEK BAR MATE-60K-KV.jpg'),
    'sizes': [('image', FEATURE)] },
]

manifest = []
for job in JOBS:
    if not os.path.isfile(job['src']):
        print('MISSING:', job['src']); continue
    entry = {'name': job['name'], 'files': {}}
    for kind, size in job['sizes']:
        dest = os.path.join(OUT, f"{job['name']}-{kind}.jpg")
        n = cover(job['src'], size, dest)
        entry['files'][kind] = {'file': os.path.basename(dest), 'bytes': n,
                                'width': size[0], 'height': size[1]}
        print(f"  {job['name']:<28} {kind:<12} {size[0]}x{size[1]}  {n/1024:.0f} KB")
    manifest.append(entry)

json.dump(manifest, open(os.path.join(ROOT, '.media-work', 'banners.json'), 'w'), indent=1)
