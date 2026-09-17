/** Minor units off the wire ("2499") as dollars ("$24.99"). Never through a float. */
export function money(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}$${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** "$19.99" or "$19.99 – $24.99". */
export function priceRange(fromMinor: string, toMinor: string): string {
  return fromMinor === toMinor ? money(fromMinor) : `${money(fromMinor)} – ${money(toMinor)}`;
}

/** A URL-safe version of a name, for the readable part of a link. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

export function productHref(id: string, name: string): string {
  return `/p/${id}/${slugify(name)}`;
}

export function brandHref(id: string, name: string): string {
  return `/b/${id}/${slugify(name)}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayName(day: number): string {
  return DAYS[day] ?? "";
}

/** "14:30" as "2:30 PM". */
export function clockTime(value: string): string {
  const [h = "0", m = "00"] = value.split(":");
  const hour = Number(h);
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m} ${suffix}`;
}

export function dateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}
