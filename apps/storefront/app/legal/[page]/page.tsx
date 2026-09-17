import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getShopInfo } from "@/lib/shop";

type Page = "terms" | "privacy" | "age-policy" | "accessibility";

const TITLES: Record<Page, string> = {
  terms: "Terms",
  privacy: "Privacy",
  "age-policy": "Age policy",
  accessibility: "Accessibility",
};

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }): Promise<Metadata> {
  const { page } = await params;
  return { title: TITLES[page as Page] ?? "Policy" };
}

export const dynamic = "force-dynamic";

/**
 * Policy pages.
 *
 * These describe how this website actually works -- what it stores, when age
 * is checked, how pickup happens -- in plain words. They are a starting point,
 * not legal documents: the shop's attorney has to review them before launch,
 * and until then the pages say so.
 */
export default async function LegalPage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!(page in TITLES)) notFound();
  const info = await getShopInfo();
  const shop = info?.shop_name ?? "This shop";

  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-5">
      <h1 className="display text-5xl font-extrabold uppercase">{TITLES[page as Page]}</h1>
      {/* Shown until the wording is replaced with reviewed text -- deliberately not
          tied to test mode, which ends when email is set up, not when a lawyer
          has read this. */}
      <p role="note" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
        Draft for review. Have an attorney check and replace this page before the site goes live.
      </p>
      <div className="flex flex-col gap-4 text-[var(--ink)] [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:text-[var(--muted)]">
        {page === "age-policy" ? (
          <>
            <p>{shop} sells products that may only be sold to adults aged 21 and older.</p>
            <h2>When we check</h2>
            <p>
              The question when you arrive on this website is a courtesy, not a check. At checkout you confirm you are
              21 or older. The check that counts happens in store: we look at a valid government-issued photo ID before
              we hand over any order that contains an age-restricted product.
            </p>
            <h2>If we can&apos;t verify your age</h2>
            <p>We won&apos;t hand the order over, and the order is cancelled. Nothing is charged, because you pay at pickup.</p>
            <h2>What we keep</h2>
            <p>
              We record that an ID was checked, when, by whom, and the age it was checked against. We don&apos;t copy,
              scan or keep your ID, your date of birth or your document number.
            </p>
          </>
        ) : page === "privacy" ? (
          <>
            <h2>What we collect</h2>
            <p>
              For an order: your name, email address, optional phone number, what you ordered and any note you add. For
              an account: the same details and your password, which is stored only in a one-way hashed form.
            </p>
            <h2>What we use it for</h2>
            <p>
              To prepare your order, tell you when it&apos;s ready, and show your order history. We send offers by email
              only if you ask for them, and you can stop them any time from your account or from any offer email.
            </p>
            <h2>What we don&apos;t do</h2>
            <p>
              We don&apos;t take payment online, so we never see your card on this site. We don&apos;t keep copies of
              ID. We don&apos;t sell your details.
            </p>
            <h2>Questions and requests</h2>
            <p>Contact the shop to see, correct or remove the details we hold about you.</p>
          </>
        ) : page === "terms" ? (
          <>
            <h2>Orders</h2>
            <p>
              Placing an order asks us to hold those items for you to collect. Prices are confirmed at pickup, and sales
              tax is added as it would be at the counter. We may decline or cancel an order, for example if an item is
              no longer available, and we&apos;ll tell you why.
            </p>
            <h2>Pickup</h2>
            <p>
              Orders are collected in store by the person who placed them, with valid photo ID for any age-restricted
              item. Payment is taken at pickup.
            </p>
            <h2>Cancelling</h2>
            <p>
              You can cancel online until we start on your order. After that, call the shop.
            </p>
          </>
        ) : (
          <>
            <p>
              We want everyone to be able to use this website, and we design it with the Web Content Accessibility
              Guidelines (WCAG) 2.2 at level AA as the goal: to work with a keyboard alone, with screen readers, when
              zoomed, and in light or dark mode.
            </p>
            <h2>Something not working?</h2>
            <p>
              Tell the shop{info?.store.phone ? ` on ${info.store.phone}` : ""} and we&apos;ll help you place your order
              another way and fix the problem.
            </p>
          </>
        )}
      </div>
    </article>
  );
}
