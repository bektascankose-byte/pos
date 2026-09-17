"""
Produce exactly what the back office's uploader would have produced.

The dashboard scales in the browser before uploading: longest side 1400 for the
display image, 256 for the thumbnail, JPEG at 0.85, flattened onto white
because a transparent PNG composited onto nothing goes black. Matching those
numbers here means these photos are indistinguishable from ones a person
uploaded, and the API needs no image library either way.
"""
import json, os
from PIL import Image

ROOT = os.path.expanduser('~/mnt/pos')
WORK = os.path.join(ROOT, '.media-work')
OUT = os.path.join(WORK, 'out')

DISPLAY_MAX, THUMB_MAX, QUALITY = 1400, 256, 85

def downscale(img, max_side):
    scale = min(1.0, max_side / max(img.width, img.height))
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    out = img.resize(size, Image.LANCZOS) if scale < 1 else img.copy()
    canvas = Image.new('RGB', out.size, (255, 255, 255))
    canvas.paste(out, (0, 0), out if out.mode in ('RGBA', 'LA') else None)
    return canvas

matched = json.load(open(os.path.join(WORK, 'matched.json')))
os.makedirs(OUT, exist_ok=True)
manifest = []

for i, row in enumerate(matched):
    src = row['image']
    with Image.open(src) as img:
        img.load()
        if img.mode not in ('RGB', 'RGBA', 'LA'):
            img = img.convert('RGBA')
        stem = f"{i:03d}"
        d_path = os.path.join(OUT, f'{stem}-display.jpg')
        t_path = os.path.join(OUT, f'{stem}-thumb.jpg')
        downscale(img, DISPLAY_MAX).save(d_path, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        downscale(img, THUMB_MAX).save(t_path, 'JPEG', quality=QUALITY, optimize=True)

    flavour = (row['variant'] or row['product']).strip()
    alt = f"{row['product']}" if not row['variant'] else f"{row['product']}, {row['variant']}"
    # File names only, not absolute paths: this script runs in a Linux VM and
    # the uploader runs on Windows, and the two see this folder at different
    # paths. The uploader resolves them against its own directory.
    entry = {'display': os.path.basename(d_path), 'thumb': os.path.basename(t_path),
             'alt_text': alt[:256],
             'source_bytes': os.path.getsize(src),
             'display_bytes': os.path.getsize(d_path),
             'thumb_bytes': os.path.getsize(t_path)}
    # one of the two, never both: the API refuses a photo claiming to be both
    if row['attach_variant']:
        entry['variant_id'] = row['variant_id']
    else:
        entry['product_id'] = row['product_id']
    manifest.append(entry)

json.dump(manifest, open(os.path.join(WORK, 'upload.json'), 'w'), indent=1)
src_total = sum(m['source_bytes'] for m in manifest)
out_total = sum(m['display_bytes'] + m['thumb_bytes'] for m in manifest)
print(f"{len(manifest)} images")
print(f"source {src_total/1e6:.1f} MB  ->  web {out_total/1e6:.1f} MB  "
      f"({out_total/src_total*100:.0f}%)")
print(f"largest display {max(m['display_bytes'] for m in manifest)/1024:.0f} KB, "
      f"median thumb {sorted(m['thumb_bytes'] for m in manifest)[len(manifest)//2]/1024:.0f} KB")
