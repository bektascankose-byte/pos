"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { NAV_ENTRIES, entryById, searchEntries, type NavEntry } from "@/lib/navigation";
import { Icon, NavIcon } from "@/app/_components/icons";
import { searchEverythingAction, type PaletteResults } from "../search-actions";
import { readRecents } from "./nav-state";

interface Row {
  key: string;
  section: string;
  icon: ReactNode;
  label: string;
  sublabel?: string;
  href: string;
}

const EMPTY: PaletteResults = { items: [], customers: [] };

function entryRow(entry: NavEntry, section: string): Row {
  return {
    key: `nav:${entry.id}`,
    section,
    icon: <NavIcon id={entry.id} size={16} />,
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
    // The top bar's search button lives outside this component's tree, so it
    // asks by event rather than by prop.
    const onOpenRequest = () => onOpenChange(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("bo:open-palette", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("bo:open-palette", onOpenRequest);
    };
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
        icon: <Icon name="box" size={16} />,
        label: hit.label,
        sublabel: hit.sublabel,
        href: hit.href,
      })),
      ...results.customers.map((hit) => ({
        key: `customer:${hit.id}`,
        section: "Customers",
        icon: <Icon name="person" size={16} />,
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
    <div className="bo-overlay" onMouseDown={() => onOpenChange(false)}>
      <div
        role="dialog"
        aria-label="Search"
        className="bo-palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="bo-palette-field">
          <Icon name="search" size={18} />
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
          aria-label="Search pages, items and customers"
        />
          {pending ? <span className="bo-palette-spinner" aria-label="Searching" /> : <kbd className="bo-kbd">Esc</kbd>}
        </div>

        <div className="bo-palette-list">
          {rows.length === 0 ? (
            <p className="bo-palette-empty">
              {pending ? "Searching…" : query.trim() ? "Nothing matched." : "Start typing."}
            </p>
          ) : null}

          {rows.map((row, index) => {
            const header = row.section !== lastSection ? row.section : null;
            lastSection = row.section;
            return (
              <div key={row.key}>
                {header ? <div className="bo-palette-section">{header}</div> : null}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(row)}
                  className={`bo-palette-row ${index === cursor ? "active" : ""}`}
                >
                  <span className="bo-palette-icon" aria-hidden>{row.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.label}</span>
                    {row.sublabel ? <span className="bo-palette-sub">{row.sublabel}</span> : null}
                  </span>
                  {index === cursor ? <kbd className="bo-kbd">Enter</kbd> : null}
                </button>
              </div>
            );
          })}
        </div>

        <div className="bo-palette-foot">
          <span><kbd className="bo-kbd">↑</kbd> <kbd className="bo-kbd">↓</kbd> to move</span>
          <span><kbd className="bo-kbd">Enter</kbd> to open</span>
          <span><kbd className="bo-kbd">Ctrl K</kbd> anywhere</span>
        </div>
      </div>
    </div>
  );
}
