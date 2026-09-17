import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Category, ComplianceRuleView, StorefrontClient } from "@snappos/contracts";
import { SellingRules } from "./SellingRules";
import { ShopKeys } from "./ShopKeys";

export const dynamic = "force-dynamic";

/** A read that a role may not be allowed to make, turned into something to say on the page. */
async function readable<T>(path: string): Promise<{ data: T } | { error: string }> {
  try {
    return { data: await apiFetch<T>(path) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return { error: "Your role can't see this section." };
    return { error: e instanceof ApiError ? e.message : "Could not load this section." };
  }
}

/**
 * The website, from the back office: what it may sell, and the keys it sells
 * with. Which items are listed lives on each item's own page, under Sell Online.
 */
export default async function WebsitePage() {
  const storeId = await primaryStoreId();
  const [rules, keys, categories] = await Promise.all([
    readable<ComplianceRuleView[]>("/api/v1/compliance/rules"),
    readable<StorefrontClient[]>("/api/v1/storefront/clients"),
    readable<Category[]>("/api/v1/catalog/categories"),
  ]);

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold">Website</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          What the website may sell, and the keys it uses to reach this system. Choose which items are listed on each
          item&apos;s page, under Sell Online.
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="rules-heading">
        <div>
          <h2 id="rules-heading" className="text-base font-semibold">
            Selling rules
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            Nothing is sold online unless a rule allows it. The built-in rules add age limits and stop vapes being
            delivered or shipped; you can outweigh them with rules of your own, but not change them. Rules take effect
            immediately and are never edited — end one and add another, so there is always a record of what was allowed
            when.
          </p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            These are settings, not legal advice. Check what may be sold online, and to whom, with your attorney.
          </p>
        </div>
        {"error" in rules ? (
          <p className="text-sm text-[var(--color-error)]">{rules.error}</p>
        ) : (
          <SellingRules rules={rules.data} categories={"data" in categories ? categories.data : []} />
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="keys-heading">
        <div>
          <h2 id="keys-heading" className="text-base font-semibold">
            Website keys
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            The website server presents one of these to this system. A key is shown once, when you create it — put it
            straight into the website&apos;s settings. If one is lost or might have leaked, revoke it and create another.
          </p>
        </div>
        {"error" in keys ? (
          <p className="text-sm text-[var(--color-error)]">{keys.error}</p>
        ) : storeId ? (
          <ShopKeys keys={keys.data} storeId={storeId} />
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">Set up a store first.</p>
        )}
      </section>
    </div>
  );
}
