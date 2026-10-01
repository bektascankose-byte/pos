"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { BrandWithLogo } from "@snappos/contracts";
import { removeBrandLogoAction, uploadBrandLogoAction } from "./brand-actions";
import { findBrandLogo, prepareLogo } from "./find-logo";

type Busy = "finding" | "uploading" | "removing";

/** Where a logo came from, as a short readable name. */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The brands, each with the logo its folder wears on the till.
 *
 * A logo is found on the web by the AI, or uploaded by hand when the one it
 * found is wrong. A new logo reaches the registers on their next pull, without
 * a Send: it changes how a folder looks, not what is sold.
 */
export function BrandsClient({ initialBrands }: { initialBrands: BrandWithLogo[] }) {
  const [brands, setBrands] = useState(initialBrands);
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);

  const setLogo = (brandId: string, logoId: string | null) =>
    setBrands((prev) => prev.map((b) => (b.id === brandId ? { ...b, logo_id: logoId, logo_source_url: null } : b)));
  const mark = (brandId: string, state: Busy | null) =>
    setBusy((prev) => {
      const next = { ...prev };
      if (state) next[brandId] = state;
      else delete next[brandId];
      return next;
    });

  /** Returns whether a logo is on the brand afterwards. */
  const find = async (brand: BrandWithLogo, replace: boolean): Promise<boolean> => {
    mark(brand.id, "finding");
    const result = await findBrandLogo(brand.id, replace);
    mark(brand.id, null);
    if (result.error) {
      setMessage({ kind: "error", text: `${brand.name}: ${result.error}` });
      return false;
    }
    if (result.logoId) {
      setLogo(brand.id, result.logoId);
      return true;
    }
    setMessage({ kind: "error", text: `No logo found for ${brand.name}. You can upload one instead.` });
    return false;
  };

  const findOne = async (brand: BrandWithLogo) => {
    setMessage(null);
    if (await find(brand, brand.logo_id !== null)) {
      setMessage({ kind: "success", text: `${brand.name} logo saved. The registers pick it up on their next sync.` });
    }
  };

  const findMissing = async () => {
    setMessage(null);
    const missing = brands.filter((b) => b.logo_id === null);
    let found = 0;
    for (const [index, brand] of missing.entries()) {
      setProgress(`Looking for ${brand.name} (${index + 1} of ${missing.length})...`);
      if (await find(brand, false)) found += 1;
    }
    setProgress(null);
    setMessage({
      kind: found === missing.length ? "success" : "error",
      text: `Found ${found} of ${missing.length} missing logos.${found < missing.length ? " Upload the rest by hand." : ""}`,
    });
  };

  const pickFile = (brandId: string) => {
    uploadTarget.current = brandId;
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    const brandId = uploadTarget.current;
    if (!brandId) return;
    setMessage(null);
    mark(brandId, "uploading");
    // Scaled and checked the same way a found logo is, so a picked file the
    // size of a poster, or one drawn in white, is caught before it ships.
    const prepared = await prepareLogo(file);
    if ("problem" in prepared) {
      mark(brandId, null);
      setMessage({ kind: "error", text: `That picture is ${prepared.problem}. Pick a logo drawn in color.` });
      return;
    }
    const formData = new FormData();
    formData.set("file", prepared.file);
    const result = await uploadBrandLogoAction(brandId, formData);
    mark(brandId, null);
    if (result.ok) {
      setLogo(brandId, result.data.logoId);
      setMessage({ kind: "success", text: "Logo saved." });
    } else {
      setMessage({ kind: "error", text: result.error });
    }
  };

  const remove = async (brand: BrandWithLogo) => {
    setMessage(null);
    mark(brand.id, "removing");
    const result = await removeBrandLogoAction(brand.id);
    mark(brand.id, null);
    if (result.ok) setLogo(brand.id, null);
    else setMessage({ kind: "error", text: result.error });
  };

  const missingCount = brands.filter((b) => b.logo_id === null).length;
  const anyBusy = progress !== null || Object.keys(busy).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Brands</h1>
        <button
          type="button"
          disabled={anyBusy || missingCount === 0}
          onClick={findMissing}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
        >
          {missingCount === 0 ? "Every brand has a logo" : `Find ${missingCount} missing logo${missingCount === 1 ? "" : "s"}`}
        </button>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Each brand is a folder on the till, and its logo is the picture on that folder. Logos are found on the web
        by AI, and the AI draft on an{" "}
        <Link href="/catalog" className="text-[var(--color-accent)]">
          item
        </Link>{" "}
        looks for one whenever it names a brand that has none. A new logo reaches the registers on their next sync,
        without a Send.
      </p>

      {progress ? <p className="text-sm text-[var(--color-text-muted)]">{progress}</p> : null}
      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Logo</th>
              <th className="px-4 py-2 font-normal">Brand</th>
              <th className="px-4 py-2 text-right font-normal">Items on sale</th>
              <th className="px-4 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {brands.map((brand) => {
              const state = busy[brand.id];
              const source = hostOf(brand.logo_source_url);
              return (
                <tr key={brand.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <div className="flex h-14 w-20 items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] bg-white">
                      {brand.logo_id ? (
                        /* eslint-disable-next-line @next/next/no-img-element -- served by this app's own proxy */
                        <img
                          src={`/api/brand-logos/${brand.logo_id}`}
                          alt={`${brand.name} logo`}
                          className="max-h-full max-w-full object-contain p-1"
                        />
                      ) : (
                        <span className="text-lg font-bold text-[var(--color-text-muted)] opacity-50">
                          {brand.name
                            .split(" ")
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((word) => word[0]!.toUpperCase())
                            .join("")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium">{brand.name}</div>
                    {source ? (
                      <a
                        href={brand.logo_source_url!}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-[var(--color-text-muted)] underline"
                      >
                        from {source}
                      </a>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{brand.product_count}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        disabled={anyBusy}
                        onClick={() => void findOne(brand)}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                      >
                        {state === "finding" ? "Looking..." : brand.logo_id ? "Find another" : "Find logo"}
                      </button>
                      <button
                        type="button"
                        disabled={anyBusy}
                        onClick={() => pickFile(brand.id)}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                      >
                        {state === "uploading" ? "Saving..." : "Upload"}
                      </button>
                      {brand.logo_id ? (
                        <button
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void remove(brand)}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-error)] disabled:opacity-40"
                        >
                          {state === "removing" ? "Removing..." : "Remove"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {brands.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No brands yet. They are made when an item is given one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
