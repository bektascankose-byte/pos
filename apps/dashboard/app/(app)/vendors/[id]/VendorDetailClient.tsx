"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { setVendorStatusAction, updateVendorAction } from "../actions";
import { VendorFields } from "../VendorFields";
import { formatMinor } from "@/lib/money";
import type { Vendor, VendorDetail } from "@snappos/contracts";

type Tab = "details" | "items" | "invoices" | "orders";

export function VendorDetailClient({ vendorId, vendor: initial }: { vendorId: string; vendor: VendorDetail }) {
  const [vendor, setVendor] = useState<Vendor>(initial);
  const [tab, setTab] = useState<Tab>("details");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [statusPending, startStatusTransition] = useTransition();
  const archived = vendor.status === "archived";

  const toggleArchived = () => {
    setMessage(null);
    startStatusTransition(async () => {
      const result = await setVendorStatusAction(vendorId, archived ? "active" : "archived");
      if (result.ok) {
        setVendor(result.data);
        setMessage({
          kind: "success",
          text: archived ? "Restored." : "Archived. Past orders and invoices are untouched.",
        });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateVendorAction(vendorId, formData);
      if (result.ok) {
        setVendor(result.data);
        setMessage({ kind: "success", text: "Saved." });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{vendor.name}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {vendor.code}
            {initial.item_count > 0 ? ` · ${initial.item_count} items` : ""}
            {archived ? " · Archived — can't be picked for a new order or invoice" : ""}
          </p>
        </div>
        <button
          type="button"
          disabled={statusPending}
          onClick={toggleArchived}
          title={
            archived
              ? "Make this vendor selectable again"
              : "Hide from vendor pickers. Past orders, invoices and item costs are kept."
          }
          className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
        >
          {statusPending ? "Saving..." : archived ? "Restore" : "Archive"}
        </button>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="flex gap-1 border-b border-[var(--color-border)] text-sm">
        <TabButton current={tab} value="details" onSelect={setTab}>
          Details
        </TabButton>
        <TabButton current={tab} value="items" onSelect={setTab}>
          Items ({initial.items.length})
        </TabButton>
        <TabButton current={tab} value="invoices" onSelect={setTab}>
          Invoices ({initial.invoices.length})
        </TabButton>
        <TabButton current={tab} value="orders" onSelect={setTab}>
          Purchase orders ({initial.purchase_orders.length})
        </TabButton>
      </div>

      {tab === "details" ? (
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <p className="text-xs text-[var(--color-text-muted)]">Leave a field blank to keep its current value.</p>
          <VendorFields vendor={vendor} />
          <button
            type="submit"
            disabled={pending}
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save"}
          </button>
        </form>
      ) : null}

      {tab === "items" ? <ItemsPanel items={initial.items} /> : null}
      {tab === "invoices" ? <InvoicesPanel invoices={initial.invoices} /> : null}
      {tab === "orders" ? <OrdersPanel orders={initial.purchase_orders} /> : null}
    </div>
  );
}

function TabButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`-mb-px border-b-2 px-3 py-2 ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-transparent text-[var(--color-text-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * What this vendor sells us, and what they charge. These rows come from
 * `vendor_variants`, which is written by committing an invoice -- so an empty
 * list means no invoice from this vendor has been committed yet, not that
 * they sell nothing.
 */
function ItemsPanel({ items }: { items: VendorDetail["items"] }) {
  return (
    <Panel
      empty={items.length === 0}
      emptyText="No items yet. Committing an invoice from this vendor records their SKUs and case costs here, and every later invoice from them matches better because of it."
    >
      <table className="w-full text-sm">
        <thead className="text-left text-[var(--color-text-muted)]">
          <tr>
            <th className="px-4 py-2 font-normal">Item</th>
            <th className="px-4 py-2 font-normal">Their SKU</th>
            <th className="px-4 py-2 text-right font-normal">Case qty</th>
            <th className="px-4 py-2 text-right font-normal">Case cost</th>
            <th className="px-4 py-2 text-right font-normal">Per unit</th>
            <th className="px-4 py-2 font-normal">Last ordered</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2">
                <Link href={`/catalog/${item.product_id}`} className="text-[var(--color-accent)]">
                  {item.product_name}
                  {item.variant_name ? ` | ${item.variant_name}` : ""}
                </Link>
              </td>
              <td className="px-4 py-2 font-mono text-xs">{item.vendor_sku}</td>
              <td className="px-4 py-2 text-right tabular-nums">{item.case_quantity}</td>
              <td className="px-4 py-2 text-right tabular-nums">${Number(item.case_cost).toFixed(2)}</td>
              <td className="px-4 py-2 text-right tabular-nums">${Number(item.unit_cost).toFixed(4)}</td>
              <td className="px-4 py-2 text-[var(--color-text-muted)]">
                {item.last_ordered_at ? new Date(item.last_ordered_at).toLocaleDateString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function InvoicesPanel({ invoices }: { invoices: VendorDetail["invoices"] }) {
  return (
    <Panel empty={invoices.length === 0} emptyText="No invoices filed under this vendor yet.">
      <table className="w-full text-sm">
        <thead className="text-left text-[var(--color-text-muted)]">
          <tr>
            <th className="px-4 py-2 font-normal">File</th>
            <th className="px-4 py-2 font-normal">Invoice #</th>
            <th className="px-4 py-2 text-right font-normal">Lines</th>
            <th className="px-4 py-2 text-right font-normal">Total</th>
            <th className="px-4 py-2 font-normal">Status</th>
            <th className="px-4 py-2 font-normal">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2">
                <Link href={`/invoice-imports/${invoice.id}`} className="text-[var(--color-accent)]">
                  {invoice.source_filename}
                </Link>
              </td>
              <td className="px-4 py-2">{invoice.vendor_invoice_no ?? "—"}</td>
              <td className="px-4 py-2 text-right tabular-nums">{invoice.line_count}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {invoice.invoice_total_minor ? formatMinor(invoice.invoice_total_minor) : "—"}
              </td>
              <td className="px-4 py-2">{invoice.status}</td>
              <td className="px-4 py-2 text-[var(--color-text-muted)]">
                {new Date(invoice.created_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function OrdersPanel({ orders }: { orders: VendorDetail["purchase_orders"] }) {
  return (
    <Panel empty={orders.length === 0} emptyText="No purchase orders for this vendor yet.">
      <table className="w-full text-sm">
        <thead className="text-left text-[var(--color-text-muted)]">
          <tr>
            <th className="px-4 py-2 font-normal">Reference</th>
            <th className="px-4 py-2 font-normal">Status</th>
            <th className="px-4 py-2 text-right font-normal">Total</th>
            <th className="px-4 py-2 font-normal">Created</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2">
                <Link href={`/inventory/purchase-orders/${order.id}`} className="text-[var(--color-accent)]">
                  {order.reference}
                </Link>
              </td>
              <td className="px-4 py-2">{order.status}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatMinor(order.total_minor)}</td>
              <td className="px-4 py-2 text-[var(--color-text-muted)]">
                {new Date(order.created_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Panel({ empty, emptyText, children }: { empty: boolean; emptyText: string; children: React.ReactNode }) {
  if (empty) {
    return (
      <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-text-muted)]">
        {emptyText}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      {children}
    </div>
  );
}
