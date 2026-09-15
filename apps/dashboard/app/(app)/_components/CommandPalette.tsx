"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NAV_ENTRIES, entryById, searchEntries, type NavEntry } from "@/lib/navigation";
import { searchEverythingAction, type PaletteResults } from "../search-actions";
import { readRecents } from "./nav-state";

interface Row {
  key: string;
  section: string;
  icon: string;
  label: string;
  sublabel?: string;
  href: string;
}

const EMPTY: PaletteResults = { items: [], customers: [] };

function entryRow(entry: NavEntry, section: string): Row {
  return {
    key: `nav:${entry.id}`,
    section,
    icon: entry.icon,
    label: entry.label,
    href: entry.href,
  };
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaletteResults>(EMPTY);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      } else if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(EMPTY);
      return;
    }
    setRecentIds(readRecents());
    inputRef.current?.focus();
  }, [open]);

  // Records come from the server; the menu itself is matched locally so those
  // rows appear on the first keystroke rather than after a round trip.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const outcome = await searchEverythingAction(q);
        if (outcome.ok) setResults(outcome.data);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [query, open]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    if (!q) {
      const recents = recentIds
        .map((id) => entryById(id))
        .filter((entry): entry is NavEntry => Boolean(entry))
        .map((entry) => entryRow(entry, "Recent"));
      if (recents.length > 0) return recents;
      return NAV_ENTRIES.filter((entry) => !entry.isAction)
        .slice(0, 6)
        .map((entry) => entryRow(entry, "Jump to"));
    }

    const matches = searchEntries(q);
    return [
      ...matches
        .filter((entry) => !entry.isAction)
        .map((entry) => entryRow(entry, "Pages")),
      ...matches.filter((entry) => entry.isAction).map((entry) => entryRow(entry, "Actions")),
      ...results.items.map((hit) => ({
        key: `item:${hit.id}`,
        section: "Items",
        icon: "📦",
        label: hit.label,
        sublabel: hit.sublabel,
        href: hit.href,
      })),
      ...results.customers.map((hit) => ({
        key: `customer:${hit.id}`,
        section: "Customers",
        icon: "👤",
        label: hit.label,
        sublabel: hit.sublabel,
        href: hit.href,
      })),
    ];
  }, [query, results, recentIds]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const go = (row: Row | undefined) => {
    if (!row) return;
    onOpenChange(false);
    router.push(row.href);
  };

  if (!open) return null;

  let lastSection = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-label="Search"
        className="w-full max-w-xl overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((current) => Math.min(current + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((current) => Math.max(current - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(rows[cursor]);
            }
          }}
          placeholder="Search pages, items, customers…"
          className="w-full border-b border-[var(--color-border)] px-4 py-3 text-sm outline-none"
        />

        <div className="max-h-96 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
              {pending ? "Searching…" : query.trim() ? "Nothing matched." : "Start typing."}
            </p>
          ) : null}

          {rows.map((row, index) => {
            const header = row.section !== lastSection ? row.section : null;
            lastSection = row.section;
            return (
              <div key={row.key}>
                {header ? (
                  <div className="px-4 pb-1 pt-3 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    {header}
                  </div>
                ) : null}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(row)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${
                    index === cursor ? "bg-[var(--color-bg)]" : ""
                  }`}
                >
                  <span aria-hidden>{row.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.label}</span>
                    {row.sublabel ? (
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">
                        {row.sublabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex justify-between border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
          <span>↑↓ to move · Enter to open · Esc to close</span>
          {pending ? <span>Searching…</span> : null}
        </div>
      </div>
    </div>
  );
}
