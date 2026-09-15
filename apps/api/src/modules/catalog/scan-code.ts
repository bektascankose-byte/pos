/**
 * A scan code as it will actually be scanned.
 *
 * Legacy exports wrap Code 39 values in the `*` start/stop characters, which
 * are part of the symbology rather than the number -- a scanner never sends
 * them. Left in, every one of those rows would be unfindable.
 *
 * Its own module rather than a method on a service: it is a pure function
 * that both the API and the import scripts need, and a script cannot load a
 * file full of Nest decorators.
 */
export function normalizeCode(code: string): string {
  const trimmed = code.trim().replace(/^\*+|\*+$/g, '').trim();

  // A stray keystroke before an otherwise perfect barcode -- "+850058810676",
  // "\011000000006" -- is a keyboard wedge or a slipped finger, not data. No
  // symbology puts punctuation in front of its digits, so stripping it is
  // safe, but only when what is left is *entirely* digits: "42030-43" and
  // "B4SLOT" are somebody's real internal codes and must survive untouched.
  const stripped = trimmed.replace(/^[^0-9A-Za-z]+/, '');
  return /^\d+$/.test(stripped) ? stripped : trimmed;
}
