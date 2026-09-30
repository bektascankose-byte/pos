import type { ReactNode, SVGProps } from "react";

/*
 * One stroke icon set for the whole back office: 24px grid, 1.8 stroke, round
 * joins, drawn in currentColor so they take whatever colour their text has.
 * Emoji used to fill this role; they render differently on every machine and
 * never matched each other, which is most of why the old screens looked
 * homemade.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

const GLYPHS = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  bag: <><path d="M5 8h14l-1.2 12.1a1 1 0 0 1-1 .9H7.2a1 1 0 0 1-1-.9L5 8Z" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></>,
  chart: <><path d="M3 21h18" /><rect x="5" y="11" width="3" height="7" rx="1" /><rect x="10.5" y="6" width="3" height="12" rx="1" /><rect x="16" y="13" width="3" height="5" rx="1" /></>,
  box: <><path d="m12 3 8.5 4.7v8.6L12 21l-8.5-4.7V7.7L12 3Z" /><path d="m3.5 7.7 8.5 4.8 8.5-4.8M12 12.5V21" /></>,
  barcode: <><path d="M4 6v12M7 6v12M11 6v12M14 6v12M17 6v12M20 6v12" /></>,
  tag: <><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z" /><circle cx="7.5" cy="7.5" r="1.3" /></>,
  plusSquare: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5ZM9 7h7" /></>,
  upload: <><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>,
  truck: <><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" /></>,
  store: <><path d="M4 9 5.5 4h13L20 9M4 9v11h16V9M4 9h16" /><path d="M9 20v-6h6v6" /></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-2.3-5" /></>,
  badge: <><rect x="4" y="3" width="16" height="18" rx="3" /><circle cx="12" cy="10" r="3" /><path d="M8 17a4 4 0 0 1 8 0" /></>,
  checks: <><path d="m3 6 2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3" /><path d="M11 7h10M11 14h10M11 21h7" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M12 13v3l2 1" /></>,
  pie: <><path d="M12 3a9 9 0 1 0 9 9h-9V3Z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15V3.5Z" /></>,
  megaphone: <><path d="M3 10v4l12 5V5L3 10Z" /><path d="M15 9a3 3 0 0 1 0 6M7 15l1 5h3l-1-4" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  gift: <><rect x="3" y="8" width="18" height="5" rx="1" /><path d="M5 13v8h14v-8M12 8v13" /><path d="M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5h4ZM12 8s1.5-5 4-5a2.5 2.5 0 0 1 0 5h-4Z" /></>,
  circle: <circle cx="12" cy="12" r="8" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrowUpRight: <path d="M7 17 17 7M8 7h9v9" />,
  trendUp: <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  alert: <><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  apps: <><circle cx="5" cy="5" r="1.6" /><circle cx="12" cy="5" r="1.6" /><circle cx="19" cy="5" r="1.6" /><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /><circle cx="5" cy="19" r="1.6" /><circle cx="12" cy="19" r="1.6" /><circle cx="19" cy="19" r="1.6" /></>,
  bolt: <path d="M13.5 2 4.5 13.5h6.5L9.5 22 19.5 10H13l.5-8Z" />,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof GLYPHS;

export function Icon({ name, ...rest }: IconProps & { name: IconName }) {
  return <Svg {...rest}>{GLYPHS[name]}</Svg>;
}

/** Which glyph stands for each page in lib/navigation.ts, by entry id. */
const NAV_GLYPH: Record<string, IconName> = {
  dashboard: "grid",
  orders: "bag",
  website: "globe",
  reports: "chart",
  catalog: "box",
  "item-lookup": "barcode",
  "price-groups": "tag",
  "catalog-new": "plusSquare",
  reference: "book",
  imports: "upload",
  "import-items": "upload",
  inventory: "layers",
  receiving: "truck",
  "receiving-new": "truck",
  "purchase-orders": "clipboard",
  "purchase-order-new": "clipboard",
  vendors: "store",
  "vendor-new": "store",
  invoices: "receipt",
  "invoice-new": "receipt",
  customers: "users",
  "import-customers": "upload",
  employees: "badge",
  "employee-new": "badge",
  onboarding: "checks",
  scheduling: "calendar",
  segments: "pie",
  campaigns: "megaphone",
  "campaign-new": "megaphone",
  suppressions: "ban",
  loyalty: "gift",
};

export function NavIcon({ id, ...rest }: IconProps & { id: string }) {
  // Spread first: SVG props carry a `name` attribute of their own, and the
  // glyph name must be the one that wins.
  return <Icon {...rest} name={NAV_GLYPH[id] ?? "circle"} />;
}
