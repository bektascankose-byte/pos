"use client";

import { useRef, useState, useTransition } from "react";
import {
  uploadProductImageAction,
  removeProductImageAction,
  reorderProductImagesAction,
} from "./image-actions";
import type { ProductImage, Variant } from "@snappos/contracts";

/** Wide enough to look sharp full-screen on a register, small enough to sync over a shop's DSL. */
const DISPLAY_MAX = 1400;
/** Big enough for a retina list row at ~64px. */
const THUMB_MAX = 256;

/**
 * Photos of a product.
 *
 * The scaling happens here, in the browser, before anything is uploaded. A
 * phone camera produces 4-to-12MB files and a shop has a few hundred products;
 * sending those as-is would fill a bucket, crawl over a shop's uplink, and
 * arrive at a register that has to pull them all down again. Two versions go
 * up instead — one to look at, one for a list row — which also means the API
 * needs no image-processing library at all.
 *
 * Attaching to a variant rather than the product is offered because flavours
 * usually look different. A single-variant product just gets the product.
 */
export function ImagePanel({
  productId,
  variants,
  initialImages,
}: {
  productId: string;
  variants: Variant[];
  initialImages: ProductImage[];
}) {
  const [images, setImages] = useState(initialImages);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [variantId, setVariantId] = useState("");

  const working = busy || pending;

  const pick = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const [display, thumb] = await Promise.all([
        downscale(file, DISPLAY_MAX),
        downscale(file, THUMB_MAX),
      ]);

      const formData = new FormData();
      formData.set("file", display);
      formData.set("thumb", thumb);
      if (variantId) formData.set("variant_id", variantId);

      startTransition(async () => {
        const result = await uploadProductImageAction(productId, formData);
        if (result.ok) setImages(result.data);
        else setError(result.error);
        if (fileRef.current) fileRef.current.value = "";
      });
    } catch {
      setError("That file could not be read as an image.");
      if (fileRef.current) fileRef.current.value = "";
    } finally {
      setBusy(false);
    }
  };

  const act = (run: () => Promise<{ ok: true; data: ProductImage[] } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await run();
      if (result.ok) setImages(result.data);
      else setError(result.error);
    });
  };

  const variantName = (id: string | null) => {
    if (!id) return null;
    const v = variants.find((variant) => variant.id === id);
    return v?.variant_name ?? v?.sku ?? null;
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div>
        <h2 className="text-sm font-medium">Photos</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          The first one is what shows in lists and on the register. Drag isn&apos;t needed — use
          &ldquo;Make main&rdquo;.
        </p>
      </div>

      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}

      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {images.map((image, index) => (
            <li
              key={image.id}
              className="flex w-36 flex-col gap-1 rounded-md border border-[var(--color-border)] p-2"
            >
              <div className="relative aspect-square overflow-hidden rounded bg-[var(--color-bg)]">
                {/* eslint-disable-next-line @next/next/no-img-element -- the bytes come through our own proxy, not a known-size remote */}
                <img
                  src={`/api/product-images/${image.id}?size=thumb`}
                  alt={image.alt_text ?? ""}
                  className="h-full w-full object-contain"
                />
                {index === 0 ? (
                  <span className="absolute left-1 top-1 rounded bg-[var(--color-accent)] px-1.5 py-0.5 text-[0.6rem] font-medium text-[var(--color-accent-contrast)]">
                    Main
                  </span>
                ) : null}
              </div>

              {variantName(image.variant_id) ? (
                <span className="truncate text-[0.7rem] text-[var(--color-text-muted)]">
                  {variantName(image.variant_id)}
                </span>
              ) : null}

              <div className="flex gap-1">
                {index === 0 ? null : (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() =>
                      act(() =>
                        reorderProductImagesAction(productId, [
                          image.id,
                          ...images.filter((other) => other.id !== image.id).map((other) => other.id),
                        ]),
                      )
                    }
                    className="flex-1 rounded border border-[var(--color-border)] px-1 py-0.5 text-[0.65rem] disabled:opacity-40"
                  >
                    Make main
                  </button>
                )}
                <button
                  type="button"
                  disabled={working}
                  onClick={() => act(() => removeProductImageAction(productId, image.id))}
                  className="flex-1 rounded border border-[var(--color-border)] px-1 py-0.5 text-[0.65rem] text-[var(--color-error)] disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">No photos yet.</p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {variants.length > 1 ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Attach to
            <select
              value={variantId}
              onChange={(e) => setVariantId(e.target.value)}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">the whole product</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.variant_name ?? variant.sku}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Add a photo
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={working}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void pick(file);
            }}
            className="text-xs file:mr-2 file:rounded-md file:border file:border-[var(--color-border)] file:bg-[var(--color-surface)] file:px-3 file:py-1 file:text-xs"
          />
        </label>

        {working ? <span className="text-xs text-[var(--color-text-muted)]">Working…</span> : null}
      </div>
    </section>
  );
}

/**
 * Re-encode an image so its longest side is at most `max` pixels.
 *
 * Aspect ratio is preserved and an image already smaller than the limit is
 * still re-encoded — that is deliberate, because it strips EXIF. A phone photo
 * carries the GPS coordinates of wherever it was taken, and a product photo
 * taken behind the counter would otherwise publish the shop's location into
 * object storage for no reason at all.
 *
 * JPEG regardless of what came in: these are photographs, PNG would be several
 * times the size for no visible gain, and a uniform output means one content
 * type to serve.
 */
async function downscale(file: File, max: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    // A transparent PNG flattened onto nothing goes black; white matches the
    // surface these are shown against.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) throw new Error("could not encode");
    return new File([blob], `${max}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
