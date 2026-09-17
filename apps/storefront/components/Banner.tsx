import Link from "next/link";
import { NICOTINE_WARNING, type ShopBanner } from "@snappos/contracts";

/**
 * The manufacturers' artwork, on the shop's pages.
 *
 * THE WARNING IS NOT OPTIONAL AND NOT A CAPTION. Federal rules require the
 * nicotine warning on advertising for these products, and hold the retailer
 * responsible for artwork the manufacturer made. `advertises_nicotine`
 * defaults to true on the way in for exactly that reason, and this draws the
 * warning in its own band across the banner rather than as small print
 * somewhere down the page.
 *
 * The picture is decoration, so it carries its alt text and the words beside
 * it are real text: a shopper who cannot load images, or cannot see them, gets
 * the headline and the link either way.
 */

function href(link: ShopBanner["link"]): string | null {
  if (!link) return null;
  switch (link.kind) {
    case "brand": return `/b/${link.value}`;
    case "category": return `/c/${link.value}`;
    case "product": return `/p/${link.value}`;
    case "search": return `/search?q=${encodeURIComponent(link.value)}`;
    default: return null;
  }
}

function Warning({ tone = "dark" }: { tone?: "dark" | "light" }) {
  return (
    <p
      className={`px-4 py-2 text-center text-[11px] font-semibold uppercase leading-tight tracking-wide sm:text-xs ${
        tone === "dark" ? "bg-black text-white" : "border-t border-[var(--line)] bg-[var(--surface)] text-[var(--ink)]"
      }`}
    >
      {NICOTINE_WARNING}
    </p>
  );
}

export function HeroBanner({ banner }: { banner: ShopBanner }) {
  const to = href(banner.link);

  const picture = (
    <picture>
      {banner.mobile_image ? (
        <source media="(max-width: 640px)" srcSet={`/banner/${banner.id}/mobile_image`} />
      ) : null}
      <img
        src={`/banner/${banner.id}/image`}
        alt={banner.alt_text}
        width={banner.image.width}
        height={banner.image.height}
        // The hero is the largest thing above the fold: fetched eagerly and
        // given priority, because it is what the page is judged on.
        fetchPriority="high"
        decoding="async"
        className="h-full w-full object-cover"
      />
    </picture>
  );

  const body = (
    <div className="relative isolate overflow-hidden rounded-3xl bg-[var(--ink)]">
      <div className="absolute inset-0 -z-10">{picture}</div>
      {/* A scrim, so the words stay readable whatever the artwork does behind them. */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/85 via-black/55 to-black/10" />
      <div className="flex min-h-[320px] flex-col justify-end gap-3 p-6 sm:min-h-[420px] sm:p-10">
        {banner.headline ? (
          <h2 className="display max-w-2xl text-3xl font-extrabold uppercase text-white sm:text-5xl">
            {banner.headline}
          </h2>
        ) : null}
        {banner.body ? <p className="max-w-lg text-sm text-white/85 sm:text-base">{banner.body}</p> : null}
        {to && banner.cta_label ? (
          <span className="mt-1 inline-flex w-fit items-center rounded-full bg-[var(--ember)] px-5 py-2.5 text-sm font-semibold text-white">
            {banner.cta_label}
          </span>
        ) : null}
      </div>
      {banner.advertises_nicotine ? <Warning /> : null}
    </div>
  );

  return to ? (
    <Link href={to} className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ember)]">
      {body}
    </Link>
  ) : (
    body
  );
}

export function FeatureBanners({ banners }: { banners: ShopBanner[] }) {
  if (banners.length === 0) return null;
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {banners.map((banner) => {
        const to = href(banner.link);
        const card = (
          <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
            <div className="aspect-[16/9] w-full overflow-hidden bg-[var(--ink)]">
              <img
                src={`/banner/${banner.id}/image`}
                alt={banner.alt_text}
                width={banner.image.width}
                height={banner.image.height}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1 p-4">
              {banner.headline ? (
                <h3 className="display text-lg font-bold uppercase">{banner.headline}</h3>
              ) : null}
              {banner.body ? <p className="text-sm text-[var(--muted)]">{banner.body}</p> : null}
              {to && banner.cta_label ? (
                <span className="mt-auto pt-2 text-sm font-semibold text-[var(--ember)]">{banner.cta_label} →</span>
              ) : null}
            </div>
            {banner.advertises_nicotine ? <Warning tone="light" /> : null}
          </div>
        );
        return (
          <li key={banner.id}>
            {to ? (
              <Link href={to} className="block h-full hover:border-[var(--muted)]">
                {card}
              </Link>
            ) : (
              card
            )}
          </li>
        );
      })}
    </ul>
  );
}
