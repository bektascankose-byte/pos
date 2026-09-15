/**
 * Every destination in the back office, declared once.
 *
 * The sidebar, the launcher grid and the command palette are three different
 * ways into the same set of pages, and the failure mode of shipping all three
 * is that they drift: a page gets added to one and missed by the others. They
 * all read this file instead.
 */

/** Which launcher tab an entry belongs under. An entry can sit in more than one. */
export type NavSurface = "work" | "reports" | "setup";

export interface NavEntry {
  id: string;
  label: string;
  href: string;
  /** Sidebar section. */
  group: NavGroup;
  surfaces: NavSurface[];
  icon: string;
  /** Extra words the palette should match on -- what someone would type looking for this. */
  keywords?: string[];
  /**
   * "Do a thing" rather than "go look at something": create forms. They're
   * offered by the palette and hidden from the sidebar, which is for places.
   */
  isAction?: boolean;
}

export type NavGroup = "Overview" | "Catalog" | "Inventory" | "Purchasing" | "People" | "Marketing";

export const NAV_GROUPS: NavGroup[] = [
  "Overview",
  "Catalog",
  "Inventory",
  "Purchasing",
  "People",
  "Marketing",
];

export const NAV_ENTRIES: NavEntry[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    href: "/",
    group: "Overview",
    surfaces: ["work"],
    icon: "🏠",
    keywords: ["today", "home", "summary"],
  },
  {
    id: "reports",
    label: "Reports",
    href: "/reports",
    group: "Overview",
    surfaces: ["reports"],
    icon: "📈",
    keywords: ["sales", "trend", "top products", "cashier", "payment"],
  },

  {
    id: "catalog",
    label: "Items",
    href: "/catalog",
    group: "Catalog",
    surfaces: ["work"],
    icon: "📦",
    keywords: ["products", "catalog", "sku"],
  },
  {
    id: "item-lookup",
    label: "Item Lookup",
    href: "/items",
    group: "Catalog",
    surfaces: ["work"],
    icon: "🔍",
    keywords: ["scan", "barcode", "carton", "case", "price check"],
  },
  {
    id: "price-groups",
    label: "Price Groups",
    href: "/catalog/price-categories",
    group: "Catalog",
    surfaces: ["setup"],
    icon: "🏷️",
    keywords: ["pricing", "price category", "bulk price"],
  },
  {
    id: "catalog-new",
    label: "Add an item",
    href: "/catalog/new",
    group: "Catalog",
    surfaces: ["work"],
    icon: "➕",
    keywords: ["new product", "create item"],
    isAction: true,
  },

  {
    id: "inventory",
    label: "Stock on hand",
    href: "/inventory",
    group: "Inventory",
    surfaces: ["work", "reports"],
    icon: "🧮",
    keywords: ["inventory", "quantity", "count", "on hand"],
  },
  {
    id: "purchase-orders",
    label: "Purchase Orders",
    href: "/inventory/purchase-orders",
    group: "Inventory",
    surfaces: ["work"],
    icon: "🚚",
    keywords: ["po", "receive", "ordering"],
  },
  {
    id: "purchase-order-new",
    label: "New purchase order",
    href: "/inventory/purchase-orders/new",
    group: "Inventory",
    surfaces: ["work"],
    icon: "➕",
    keywords: ["order stock", "reorder"],
    isAction: true,
  },

  {
    id: "vendors",
    label: "Vendors",
    href: "/vendors",
    group: "Purchasing",
    surfaces: ["work", "setup"],
    icon: "🏭",
    keywords: ["supplier", "distributor", "rep", "terms", "who we buy from"],
  },
  {
    id: "vendor-new",
    label: "Add a vendor",
    href: "/vendors/new",
    group: "Purchasing",
    surfaces: ["setup"],
    icon: "➕",
    keywords: ["new supplier", "new distributor"],
    isAction: true,
  },
  {
    id: "invoices",
    label: "Invoices",
    href: "/invoice-imports",
    group: "Purchasing",
    surfaces: ["work"],
    icon: "🧾",
    keywords: ["vendor", "bill", "import", "scan invoice"],
  },
  {
    id: "invoice-new",
    label: "Upload an invoice",
    href: "/invoice-imports/new",
    group: "Purchasing",
    surfaces: ["work"],
    icon: "⬆️",
    keywords: ["new invoice", "vendor bill", "pdf", "csv"],
    isAction: true,
  },

  {
    id: "customers",
    label: "Customers",
    href: "/customers",
    group: "People",
    surfaces: ["work"],
    icon: "👤",
    keywords: ["shopper", "phone", "account"],
  },
  {
    id: "employees",
    label: "Employees",
    href: "/employees",
    group: "People",
    surfaces: ["work", "setup"],
    icon: "🧑‍💼",
    keywords: ["staff", "roles", "pin"],
  },
  {
    id: "employee-new",
    label: "Add an employee",
    href: "/employees/new",
    group: "People",
    surfaces: ["setup"],
    icon: "➕",
    keywords: ["hire", "new staff"],
    isAction: true,
  },
  {
    id: "onboarding",
    label: "Onboarding Templates",
    href: "/employees/onboarding",
    group: "People",
    surfaces: ["setup"],
    icon: "✅",
    keywords: ["checklist", "new hire tasks"],
  },
  {
    id: "scheduling",
    label: "Scheduling",
    href: "/scheduling",
    group: "People",
    surfaces: ["work"],
    icon: "📅",
    keywords: ["shifts", "roster", "calendar"],
  },

  {
    id: "loyalty",
    label: "Loyalty",
    href: "/loyalty",
    group: "Marketing",
    surfaces: ["work", "setup"],
    icon: "⭐",
    keywords: ["points", "rewards", "program"],
  },
];

export function entryById(id: string): NavEntry | undefined {
  return NAV_ENTRIES.find((entry) => entry.id === id);
}

/**
 * Which entry is the page currently being looked at? Longest matching href
 * wins, so `/catalog/01a0…` highlights Items and `/inventory/purchase-orders`
 * highlights Purchase Orders rather than Stock on hand. Actions are skipped:
 * `/catalog/new` is still the Items section as far as the sidebar goes.
 */
export function activeEntry(pathname: string): NavEntry | undefined {
  let best: NavEntry | undefined;
  for (const entry of NAV_ENTRIES) {
    if (entry.isAction) continue;
    const matches = entry.href === "/" ? pathname === "/" : pathname === entry.href || pathname.startsWith(`${entry.href}/`);
    if (!matches) continue;
    if (!best || entry.href.length > best.href.length) best = entry;
  }
  return best;
}

/** Substring match over label and keywords, labels first. Small enough a list that anything cleverer would be for show. */
export function searchEntries(query: string): NavEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byLabel: NavEntry[] = [];
  const byKeyword: NavEntry[] = [];
  for (const entry of NAV_ENTRIES) {
    if (entry.label.toLowerCase().includes(q)) byLabel.push(entry);
    else if (entry.keywords?.some((word) => word.includes(q))) byKeyword.push(entry);
  }
  return [...byLabel, ...byKeyword];
}
