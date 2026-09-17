import Link from "next/link";
import type { ShopInfo } from "@snappos/contracts";
import { clockTime, dayName } from "@/lib/format";

export function Footer({ info }: { info: ShopInfo | null }) {
  const store = info?.store;
  const address = [store?.address_line1, [store?.city, store?.region].filter(Boolean).join(", "), store?.postal_code]
    .filter(Boolean)
    .join(" ");

  return (
    <footer className="border-t border-[var(--line)] bg-[var(--surface)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3 sm:px-6">
        <div>
          <p className="display text-xl font-bold uppercase">{info?.shop_name ?? "Shop"}</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Order online, pay and pick up in store. You must be 21 or older, and we check photo ID at the counter.
          </p>
        </div>

        <div className="text-sm">
          <h2 className="eyebrow">Pick up at</h2>
          <p className="mt-2">{store?.name ?? ""}</p>
          {address ? <p className="text-[var(--muted)]">{address}</p> : null}
          {store?.phone ? (
            <p className="mt-1">
              <a href={`tel:${store.phone}`} className="underline underline-offset-2">
                {store.phone}
              </a>
            </p>
          ) : null}
          {info?.hours.length ? (
            <table className="tabular mt-3 text-sm">
              <caption className="sr-only">Pickup hours</caption>
              <tbody>
                {info.hours.map((row) => (
                  <tr key={row.day_of_week}>
                    <th scope="row" className="pr-4 text-left font-normal text-[var(--muted)]">
                      {dayName(row.day_of_week)}
                    </th>
                    <td>
                      {clockTime(row.opens_at)} – {clockTime(row.closes_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        <nav aria-label="Policies" className="text-sm">
          <h2 className="eyebrow">Policies</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            <li>
              <Link href="/store" className="underline-offset-2 hover:underline">
                Store &amp; pickup
              </Link>
            </li>
            <li>
              <Link href="/legal/age-policy" className="underline-offset-2 hover:underline">
                Age policy
              </Link>
            </li>
            <li>
              <Link href="/legal/privacy" className="underline-offset-2 hover:underline">
                Privacy
              </Link>
            </li>
            <li>
              <Link href="/legal/terms" className="underline-offset-2 hover:underline">
                Terms
              </Link>
            </li>
            <li>
              <Link href="/legal/accessibility" className="underline-offset-2 hover:underline">
                Accessibility
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <p className="border-t border-[var(--line)] px-4 py-4 text-center text-xs text-[var(--muted)]">
        Sold only to adults 21 and older. Photo ID is checked at pickup.
      </p>
    </footer>
  );
}
