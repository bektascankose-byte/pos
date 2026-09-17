"""
Match a catalogue flavour to the manufacturer's own photo of it.

Scoped per product line, deliberately. Both kits ship a "Blue Razz Ice", and a
global flavour->file map would happily put a Foger pod on a Geek Bar product:
the same flavour name, a completely different device, and a picture that lies
about what arrives in the bag. A flavour only matches within its own line.
"""
import os, re, json, unicodedata

ROOT = os.path.expanduser('~/mnt/pos')
MK = os.path.join(ROOT, 'marketing')

# line -> directory of one-image-per-flavour shots on white
LINES = {
  'foger-switchpro-pod': os.path.join(
      MK, 'Foger Switch Pro Pods', 'Foger Switch Pro Disposable Pod Media Kit New',
      'Foger Switch Pro Disposable Pod Media Kit New',
      '2. Single Flavor Image White Background', 'Single Flavor', 'JPG Version'),
  'geekbar-pulse-x': os.path.join(MK, 'Geek Bar Pulse', 'packages', 'device+small box'),
}

NOISE = ['flavor side', 'flavour side', 'single flavor', 'logo side',
         'foger', 'switchpro', 'switch pro', 'disposable', 'pod',
         'geek bar', 'pulse x', 'pulse']

# Filenames the manufacturer spelled differently from the invoice.
ALIASES = {'cherry bomp': 'cherry bomb'}

def norm(s):
    s = unicodedata.normalize('NFKD', s).lower()
    s = re.sub(r'\.(jpg|jpeg|png)$', '', s)
    s = s.replace('-', ' ').replace('_', ' ').replace('+', ' ')
    for n in NOISE:
        s = s.replace(n, ' ')
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return ALIASES.get(s, s)

def line_of(brand, product):
    """Which product line a catalogue row belongs to, or None for one with no kit."""
    p = product.lower()
    if brand == 'Foger' and 'switchpro' in p.replace(' ', ''):
        return 'foger-switchpro-pod'
    if brand == 'Geek Bar' and 'pulse' in p:
        return 'geekbar-pulse-x'
    return None   # Geek Bar CLR is a different device; Lost Mary has no kit

images = {}
for line, d in LINES.items():
    if not os.path.isdir(d):
        print('MISSING DIR:', d); continue
    for f in sorted(os.listdir(d)):
        if f.lower().endswith(('.jpg', '.jpeg', '.png')):
            images.setdefault((line, norm(f)), os.path.join(d, f))

rows = []
for raw in open(os.path.join(ROOT, 'catalog.txt'), encoding='utf-8'):
    raw = raw.rstrip('\n')
    if not raw.strip(): continue
    parts = raw.split('|')
    pid, vid, brand, vname = parts[0], parts[1], parts[2], parts[-1]
    pname = '|'.join(parts[3:-1])
    rows.append({'product_id': pid, 'variant_id': vid, 'brand': brand,
                 'product': pname, 'variant': vname,
                 'line': line_of(brand, pname),
                 'key': norm(vname.strip() or pname)})

matched, missed, nokit = [], [], []
for r in rows:
    if r['line'] is None:
        nokit.append(r); continue
    path = images.get((r['line'], r['key']))
    if path:
        r['image'] = path
        # a per-variant product line attaches to the variant; a one-flavour-per-
        # product line attaches to the product so the catalogue tile has it too
        r['attach_variant'] = bool(r['variant'].strip())
        matched.append(r)
    else:
        missed.append(r)

print(f'catalog rows {len(rows)} | images {len(images)}')
print(f'MATCHED {len(matched)} | no artwork {len(missed)} | line has no kit {len(nokit)}')
for label, group in (('no artwork in the kit', missed), ('product line has no kit', nokit)):
    print(f'\n--- {label} ({len(group)}) ---')
    for r in group:
        print(f"  {r['brand']:<10} {r['product']} {('/ ' + r['variant']) if r['variant'] else ''}")

json.dump(matched, open(os.path.join(ROOT, '.media-work', 'matched.json'), 'w'), indent=1)
print('\nwrote .media-work/matched.json')
