"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NAV_ENTRIES, entryById, type NavEntry, type NavSurface } from "@/lib/navigation";
import { readRecents } from "./nav-state";

const TABS: { id: NavSurface | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "reports", label: "Reports" },
  { id: "setup", label: "Setup" },
];

export function Launcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<NavSurface | "all">("all");
  const [filter, setFilter] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      setFilter("");
      return;
    }
    setRecentIds(readRecents());
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tiles = useMemo<NavEntry[]>(() => {
    const q = filter.trim().toLowerCase();
    return NAV_ENTRIES.filter((entry) => {
      if (tab !== "all" && !entry.surfaces.includes(tab)) return false;
      if (!q) return true;
      return (
        entry.label.toLowerCase().includes(q) || entry.keywords?.some((word) => word.includes(q))
      );
    });
  }, [tab, filter]);

  const recents = recentIds
    .map((id) => entryById(id))
    .filter((entry): entry is NavEntry => Boolean(entry))
    .slice(0, 5);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 p-4"
      onMouseDown={onClose}
      role="dialog"
      aria-label="All apps"
    >
      <div
        className="mx-auto mt-16 w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex gap-1 border-b border-[var(--color-border)] px-2">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`px-4 py-3 text-sm ${
                tab === entry.id
                  ? "border-b-2 border-[var(--color-accent)] font-medium text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="px-4 pt-4">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div className="grid max-h-80 grid-cols-3 gap-3 overflow-y-auto p-4 sm:grid-cols-4">
          {tiles.map((entry) => (
            <Link
              key={entry.id}
              href={entry.href}
              onClick={onClose}
              className="flex flex-col items-center gap-2 rounded-lg border border-[var(--color-border)] p-3 text-center hover:bg-[var(--color-bg)]"
            >
              <span className="text-2xl" aria-hidden>
                {entry.icon}
              </span>
              <span className="text-xs">{entry.label}</span>
            </Link>
          ))}
          {tiles.length === 0 ? (
            <p className="col-span-full py-6 text-center text-sm text-[var(--color-text-muted)]">
              Nothing matched.
            </p>
          ) : null}
        </div>

        {recents.length > 0 ? (
          <div className="border-t border-[var(--color-border)] px-4 py-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
              Recent
            </div>
            <div className="flex flex-wrap gap-2">
              {recents.map((entry) => (
                <Link
                  key={entry.id}
                  href={entry.href}
                  onClick={onClose}
                  className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-bg)]"
                >
                  {entry.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
