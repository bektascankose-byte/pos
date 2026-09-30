"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NAV_ENTRIES, entryById, type NavEntry, type NavSurface } from "@/lib/navigation";
import { Icon, NavIcon } from "@/app/_components/icons";
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
    <div className="bo-overlay" onMouseDown={onClose} role="dialog" aria-label="All apps">
      <div className="bo-launcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bo-launcher-head">
          <div className="bo-segmented" role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={tab === entry.id ? "active" : ""}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="bo-palette-field bo-launcher-filter">
            <Icon name="search" size={16} />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find an app"
              aria-label="Find an app"
            />
          </div>
        </div>

        <div className="bo-launcher-grid">
          {tiles.map((entry) => (
            <Link key={entry.id} href={entry.href} onClick={onClose} className="bo-launcher-tile">
              <span className="bo-launcher-tile-icon">
                <NavIcon id={entry.id} size={20} />
              </span>
              <span>{entry.label}</span>
            </Link>
          ))}
          {tiles.length === 0 ? <p className="bo-palette-empty col-span-full">Nothing matched.</p> : null}
        </div>

        {recents.length > 0 ? (
          <div className="bo-launcher-recents">
            <div className="bo-palette-section">Recent</div>
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              {recents.map((entry) => (
                <Link key={entry.id} href={entry.href} onClick={onClose} className="bo-chip">
                  <NavIcon id={entry.id} size={13} />
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
