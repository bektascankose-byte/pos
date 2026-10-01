import { findBrandLogoCandidatesAction, uploadBrandLogoAction } from "./brand-actions";

/** Longest side a logo is kept at. A folder on the till draws it a few centimetres wide. */
const LOGO_MAX = 512;

/** Below this a found image is a favicon, and would be a smudge on a folder. */
const LOGO_MIN = 48;

/**
 * Of the picture's area, how much has to be something other than near white
 * once it is laid on white. A logo drawn in white on a clear background,
 * which brand websites use over their dark headers, lands at zero.
 */
const MIN_VISIBLE_SHARE = 0.01;

/**
 * Scale a found image for the till and check it would show there.
 *
 * Laid on white, because the till draws its folders on a light surface: a
 * logo that only works on a dark background is caught here rather than
 * shipped to every register as an empty white box. Kept as PNG, which keeps a
 * wordmark's edges sharp where a JPEG would smear them.
 */
export async function prepareLogo(blob: Blob): Promise<{ file: File } | { problem: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { problem: "not a picture this browser can read" };
  }
  try {
    if (Math.max(bitmap.width, bitmap.height) < LOGO_MIN) return { problem: "too small" };

    const scale = Math.min(1, LOGO_MAX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { problem: "this browser cannot draw it" };
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const pixels = context.getImageData(0, 0, width, height).data;
    let visible = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
      if (luminance < 225) visible += 1;
    }
    if (visible / (width * height) < MIN_VISIBLE_SHARE) {
      return { problem: "white or empty, so it would not show on the till" };
    }

    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) return { problem: "could not be saved" };
    return { file: new File([png], "logo.png", { type: "image/png" }) };
  } finally {
    bitmap.close();
  }
}

export interface FoundBrandLogo {
  /** The logo now on the brand, or null when nothing usable turned up. */
  logoId: string | null;
  /** True when the brand already had a logo and kept it. */
  kept: boolean;
  /** What went wrong with the search itself, as opposed to finding nothing. */
  error?: string;
}

/**
 * Find a brand's logo with AI and keep the first candidate that would show.
 *
 * The API names where logos might be; this fetches each through the stock
 * image proxy, prepares it with `prepareLogo` and uploads the first good one,
 * recording where it came from.
 */
export async function findBrandLogo(brandId: string, replace: boolean): Promise<FoundBrandLogo> {
  const found = await findBrandLogoCandidatesAction(brandId, replace);
  if (!found.ok) return { logoId: null, kept: false, error: found.error };
  if (found.data.kept) return { logoId: null, kept: true };

  for (const candidate of found.data.candidates) {
    try {
      const response = await fetch(`/api/stock-image?url=${encodeURIComponent(candidate.url)}`);
      if (!response.ok) continue;
      const prepared = await prepareLogo(await response.blob());
      if ("problem" in prepared) continue;

      const formData = new FormData();
      formData.set("file", prepared.file);
      formData.set("source_url", candidate.source);
      const uploaded = await uploadBrandLogoAction(brandId, formData);
      if (uploaded.ok) return { logoId: uploaded.data.logoId, kept: false };
    } catch {
      // One unusable candidate is not a failure while there are others.
    }
  }
  return { logoId: null, kept: false };
}
