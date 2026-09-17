# Media import

One-off tooling for putting a manufacturer's media kit onto the catalogue and
the website. New kits arrive when a supplier launches a product, so this is
kept rather than rewritten each time.

Nothing here writes to the database. Everything goes through the ordinary API
as the owner, so each photo and banner lands with an audit entry naming who
uploaded it, and the bytes reach object storage the way they always do.

## Running it

The kits are not in the repository — see the `marketing/` note in
`.gitignore`. Point `LINES` in `match.py` at wherever they are.

```
# 1. export the catalogue rows the kits might cover
psql -A -F'|' -t -f catalog.sql > catalog.txt

# 2. match flavour names to files, and read the report
python3 match.py

# 3. scale to the sizes the back office uploader produces
python3 convert.py          # product photos: 1400px display, 256px thumb
python3 banners.py          # key visuals: 1920x760 wide, 900x1100 for phones

# 4. upload (needs the API running)
node upload.mjs             # product photos
node upload-banners.mjs     # banners, and list the photographed items
```

## Two things that will bite

**Matching is scoped per product line, deliberately.** Several kits ship a
"Blue Razz Ice". A global flavour-to-file map will happily put a Foger pod on a
Geek Bar product: same flavour name, different device, and a photo that lies
about what is in the bag. `line_of()` decides which kit a catalogue row may
draw from, and a row whose line has no kit matches nothing.

**A missing photo beats a wrong one.** `match.py` prints what it could not
match and why. Read that list rather than loosening the matching until the
number goes up: the unmatched rows are usually flavours the shop stocks and the
kit does not cover, and the near-misses are worth checking by hand.

## What the scaling matches

The back office scales in the browser before uploading -- longest side 1400 for
the display image and 256 for the thumbnail, JPEG at 0.85, flattened onto white
because a transparent PNG composited onto nothing goes black. `convert.py`
reproduces those numbers, so these photos are indistinguishable from ones a
person uploaded and the API still needs no image library.
