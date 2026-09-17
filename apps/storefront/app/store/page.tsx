import type { Metadata } from "next";
import { clockTime, dayName } from "@/lib/format";
import { getShopInfo } from "@/lib/shop";

export const metadata: Metadata = { title: "Store & pickup" };
export const dynamic = "force-dynamic";

export default async function StorePage() {
  const info = await getShopInfo();
  const store = info?.store;
  const address = [store?.address_line1, store?.address_line2, [store?.city, store?.region].filter(Boolean).join(", "), store?.postal_code]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <h1 className="display text-5xl font-extrabold uppercase">Store &amp; pickup</h1>

      <section aria-labelledby="where" className="grid gap-6 rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 sm:grid-cols-2">
        <div>
          <h2 id="where" className="eyebrow">
            Where
          </h2>
          <p className="mt-2 text-lg font-semibold">{store?.name}</p>
          {address ? <p className="text-[var(--muted)]">{address}</p> : null}
          {store?.phone ? (
            <p className="mt-2">
              <a href={`tel:${store.phone}`} className="underline underline-offset-2">
                {store.phone}
              </a>
            </p>
          ) : null}
        </div>
        <div>
          <h2 className="eyebrow">Pickup hours</h2>
          {info?.hours.length ? (
            <table className="tabular mt-2 text-sm">
              <caption className="sr-only">Pickup hours</caption>
              <tbody>
                {info.hours.map((row) => (
                  <tr key={row.day_of_week}>
                    <th scope="row" className="pr-6 text-left font-normal text-[var(--muted)]">
                      {dayName(row.day_of_week)}
                    </th>
                    <td>
                      {clockTime(row.opens_at)} – {clockTime(row.closes_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-sm text-[var(--muted)]">Call the shop for today&apos;s hours.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="how" className="flex flex-col gap-4">
        <h2 id="how" className="display text-3xl font-bold uppercase">
          How pickup works
        </h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            ["Order online", "Choose what you want and check out. Nothing is charged online."],
            ["We get it ready", "We email you as soon as your order is waiting at the counter."],
            ["Show ID, pay, go", "Bring a valid photo ID. You pay in store when you collect."],
          ].map(([title, body], index) => (
            <li key={title} className="flex flex-col gap-2 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <span className="display text-3xl font-extrabold text-[var(--ember)]">{index + 1}</span>
              <span className="font-semibold">{title}</span>
              <span className="text-sm text-[var(--muted)]">{body}</span>
            </li>
          ))}
        </ol>
        <p className="text-sm text-[var(--muted)]">
          We hand orders over only to the person who placed them, in person, after checking their photo ID. If you
          can&apos;t show ID, we can&apos;t hand the order over.
        </p>
      </section>
    </div>
  );
}
