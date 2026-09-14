import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import type { PriceCategory, PriceCategoryMember } from "@snappos/contracts";
import {
  setPriceCategoryPriceAction,
  removePriceCategoryMemberAction,
  scanAddToPriceCategoryAction,
} from "../../actions";

export default async function PriceCategoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string; justAdded?: string }>;
}) {
  const { id } = await params;
  const { saved, error, justAdded } = await searchParams;
  const storeId = await primaryStoreId();

  let category: PriceCategory & { members: PriceCategoryMember[] };
  try {
    const qs = storeId ? `?store_id=${storeId}` : "";
    category = await apiFetch<PriceCategory & { members: PriceCategoryMember[] }>(
      `/api/v1/catalog/price-categories/${id}${qs}`,
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const setPrice = setPriceCategoryPriceAction.bind(null, id);
  const scanAdd = scanAddToPriceCategoryAction.bind(null, id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{category.name ?? "(unnamed)"}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {category.member_count} member{category.member_count === 1 ? "" : "s"} ·{" "}
            {/* Digit string over the wire, not the branded `Money` this shares a schema with -- see catalog/[id]/page.tsx. */}
            {category.current_price_minor !== null
              ? formatMinor(String(category.current_price_minor))
              : category.member_count === 0
                ? "no members yet"
                : "mixed price"}
          </p>
        </div>
        <Link href="/catalog/price-categories" className="text-sm text-[var(--color-accent)]">
          ← All categories
        </Link>
      </div>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {justAdded ? (
        <p className="text-sm text-[var(--color-success)]">Added: {justAdded}</p>
      ) : null}

      <div className="flex flex-wrap gap-4">
        <form
          action={setPrice}
          className="flex items-end gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <label className="flex flex-col gap-1 text-sm">
            Set price for this category
            <input
              name="price"
              placeholder="9.99"
              className="w-28 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Apply to every member
          </button>
        </form>

        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <span className="text-sm font-medium">Speed-scan add</span>
          <form id="scan-form" data-category-id={id} action={scanAdd} className="flex items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Scan or type a SKU / barcode
              <input
                id="scan-input"
                name="code"
                autoFocus
                autoComplete="off"
                className="w-48 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <button
              type="submit"
              className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
            >
              Add
            </button>
          </form>
          <p id="scan-status" className="text-xs text-[var(--color-text-muted)]"></p>
          <p id="scan-count" className="text-xs text-[var(--color-text-muted)]"></p>
          <ul id="scan-list" className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]"></ul>
          <p className="text-xs text-[var(--color-text-muted)]">
            Each scan is added right away — nothing to &quot;complete.&quot; Remove a mis-scan from the
            table below.
          </p>
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        Add more members the traditional way from the{" "}
        <Link href="/catalog" className="text-[var(--color-accent)]">
          catalog list
        </Link>
        &apos;s checkboxes. Adding an item here moves it out of any other price category it was in.
      </p>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Product</th>
              <th className="px-4 py-2 font-normal">SKU</th>
              <th className="px-4 py-2 font-normal">Price</th>
              <th className="px-4 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {category.members.map((m) => {
              const remove = removePriceCategoryMemberAction.bind(null, id, m.variant_id);
              return (
                <tr key={m.variant_id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <Link href={`/catalog/${m.product_id}`} className="text-[var(--color-accent)]">
                      {m.product_name}
                      {m.variant_name ? ` — ${m.variant_name}` : ""}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{m.sku}</td>
                  <td className="px-4 py-2">
                    {m.price_minor !== null ? formatMinor(String(m.price_minor)) : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <form action={remove}>
                      <button type="submit" className="text-[var(--color-error)]">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {category.members.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No members yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Progressively enhances the scan form above: without this, it still works as a real form submit. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var form = document.getElementById('scan-form');
  var input = document.getElementById('scan-input');
  var status = document.getElementById('scan-status');
  var list = document.getElementById('scan-list');
  var count = document.getElementById('scan-count');
  if (!form || !input || !status || !list || !count) return;
  var categoryId = form.getAttribute('data-category-id');
  var added = 0;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = input.value.trim();
    if (!code) return;
    status.textContent = 'Adding...';
    fetch('/api/price-categories/' + categoryId + '/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          status.textContent = (result.data && result.data.error) || ('Not found: ' + code);
          return;
        }
        added += 1;
        count.textContent = added + ' added this session';
        var li = document.createElement('li');
        var name = result.data.product_name + (result.data.variant_name ? ' — ' + result.data.variant_name : '');
        li.textContent = name + ' (' + result.data.sku + ')';
        list.insertBefore(li, list.firstChild);
        status.textContent = 'Added: ' + result.data.sku;
      })
      .catch(function () {
        status.textContent = 'Could not reach the server.';
      })
      .finally(function () {
        input.value = '';
        input.focus();
      });
  });
})();
`,
        }}
      />
    </div>
  );
}
