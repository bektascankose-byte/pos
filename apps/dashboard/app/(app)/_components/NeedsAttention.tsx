import Link from "next/link";
import { formatMinor } from "@/lib/money";
import type { AttentionGroup, AttentionItem, NeedsAttention } from "@snappos/contracts";

/**
 * The open loops, phrased here rather than in the API: the endpoint returns
 * the numbers that make each item qualify, and how to say it belongs to
 * whoever is showing it.
 *
 * Groups with nothing in them don't render at all. A dashboard listing five
 * headings that all say "0" teaches people to stop reading it.
 */
export function NeedsAttentionSection({ attention }: { attention: NeedsAttention }) {
  const cards = [
    {
      key: "negative_stock",
      title: "Stock below zero",
      tone: "danger" as const,
      blurb: "Something sold that wasn't on the books. Every count downstream is off.",
      group: attention.negative_stock,
      href: (item: AttentionItem) => `/inventory/${item.variant_id}`,
      detail: (item: AttentionItem) => `${Number(item.on_hand)} on hand`,
    },
    {
      key: "below_cost",
      title: "Selling below cost",
      tone: "danger" as const,
      blurb: "Losing money on every one of these that goes out the door.",
      group: attention.below_cost,
      href: (item: AttentionItem) => `/catalog/${item.product_id}`,
      detail: (item: AttentionItem) =>
        `${item.price_minor ? formatMinor(item.price_minor) : "—"} · costs $${Number(item.cost ?? 0).toFixed(2)}`,
    },
    {
      key: "unpriced",
      title: "No price set",
      tone: "warn" as const,
      blurb: "The register refuses these — they can't be rung up at all.",
      group: attention.unpriced,
      href: (item: AttentionItem) => `/catalog/${item.product_id}`,
      detail: (item: AttentionItem) => `UPC ${item.sku}`,
    },
    {
      key: "low_stock",
      title: "Below reorder point",
      tone: "warn" as const,
      blurb: "Time to order more.",
      group: attention.low_stock,
      href: (item: AttentionItem) => `/inventory/${item.variant_id}`,
      detail: (item: AttentionItem) =>
        `${Number(item.on_hand)} left · reorders at ${Number(item.reorder_point)}`,
    },
    {
      key: "dead_stock",
      title: "Not sold in 60 days",
      tone: "neutral" as const,
      blurb: "Money sitting on a shelf.",
      group: attention.dead_stock,
      href: (item: AttentionItem) => `/inventory/${item.variant_id}`,
      detail: (item: AttentionItem) =>
        `${Number(item.on_hand)} on hand · ${
          item.last_sold_at ? `last sold ${new Date(item.last_sold_at).toLocaleDateString()}` : "never sold"
        }`,
    },
  ].filter((card) => card.group.count > 0);

  const invoices = attention.open_invoices;
  const nothingToDo = cards.length === 0 && invoices.count === 0;

  if (nothingToDo) {
    return (
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-medium">Nothing needs you</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Everything is priced, in stock, moving, and every invoice is committed.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Needs you</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <AttentionCard
            key={card.key}
            title={card.title}
            tone={card.tone}
            blurb={card.blurb}
            group={card.group}
            href={card.href}
            detail={card.detail}
          />
        ))}

        {invoices.count > 0 ? (
          <article className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <header className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium">Invoices not committed</h3>
              <span className="text-2xl font-semibold tabular-nums">{invoices.count}</span>
            </header>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Parsed but never committed, so their stock was never received.
            </p>
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {invoices.items.map((invoice) => (
                <li key={invoice.id}>
                  <Link
                    href={`/invoice-imports/${invoice.id}`}
                    className="block truncate text-[var(--color-accent)]"
                  >
                    {invoice.source_filename}
                  </Link>
                  <span className="text-xs capitalize text-[var(--color-text-muted)]">
                    {invoice.status} · {new Date(invoice.created_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function AttentionCard({
  title,
  tone,
  blurb,
  group,
  href,
  detail,
}: {
  title: string;
  tone: "danger" | "warn" | "neutral";
  blurb: string;
  group: AttentionGroup;
  href: (item: AttentionItem) => string;
  detail: (item: AttentionItem) => string;
}) {
  const countColor =
    tone === "danger"
      ? "text-[var(--color-error)]"
      : tone === "warn"
        ? "text-[var(--color-text)]"
        : "text-[var(--color-text-muted)]";

  return (
    <article className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className={`text-2xl font-semibold tabular-nums ${countColor}`}>{group.count}</span>
      </header>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{blurb}</p>
      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {group.items.map((item) => (
          <li key={item.variant_id}>
            <Link href={href(item)} className="block truncate text-[var(--color-accent)]">
              {item.product_name}
              {item.variant_name ? ` | ${item.variant_name}` : ""}
            </Link>
            <span className="text-xs text-[var(--color-text-muted)]">{detail(item)}</span>
          </li>
        ))}
      </ul>
      {group.count > group.items.length ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          and {group.count - group.items.length} more
        </p>
      ) : null}
    </article>
  );
}
