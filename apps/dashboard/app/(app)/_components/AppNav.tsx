"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  NAV_ENTRIES,
  NAV_GROUPS,
  activeEntry,
  entryById,
  type NavEntry,
} from "@/lib/navigation";
import { pushRecent, readPins, readRecents, togglePin } from "./nav-state";
import { Launcher } from "./Launcher";
import { CommandPalette } from "./CommandPalette";

export function AppNav() {
  const pathname = usePathname();
  const [pins, setPins] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Read after mount, never during render: the server has no localStorage, and
  // rendering from it directly is a hydration mismatch.
  useEffect(() => {
    setPins(readPins());
    setRecents(readRecents());
  }, []);

  const active = activeEntry(pathname);
  const activeId = active?.id;

  useEffect(() => {
    if (activeId) setRecents(pushRecent(activeId));
    setMobileOpen(false);
  }, [activeId]);

  const pinned = pins
    .map((id) => entryById(id))
    .filter((entry): entry is NavEntry => Boolean(entry));

  const recentlyVisited = recents
    .map((id) => entryById(id))
    .filter((entry): entry is NavEntry => entry !== undefined)
    .filter((entry) => entry.id !== activeId)
    .slice(0, 4);

  return (
    <>
      <button type="button" className="bo-mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation">☰</button>
      {mobileOpen ? <button type="button" className="bo-mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" /> : null}
      <aside className={`bo-sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="bo-brand">
          <button
            type="button"
            onClick={() => setLauncherOpen(true)}
            title="All apps"
            aria-label="All apps"
            className="bo-brand-mark"
          >
            S
          </button>
          <div><div className="bo-brand-name">SnapPOS</div><div className="bo-brand-subtitle">Store management</div></div>
          <button type="button" className="ml-auto text-lg md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="bo-search"
        >
          <span>⌕ &nbsp; Search anything</span>
          <kbd>Ctrl K</kbd>
        </button>

        <nav className="bo-nav">
          {pinned.length > 0 ? (
            <Section title="Pinned">
              {pinned.map((entry) => (
                <NavRow
                  key={entry.id}
                  entry={entry}
                  active={entry.id === activeId}
                  pinned
                  onTogglePin={() => setPins(togglePin(entry.id))}
                />
              ))}
            </Section>
          ) : null}

          {NAV_GROUPS.map((group) => {
            const entries = NAV_ENTRIES.filter(
              (entry) => entry.group === group && !entry.isAction && !pins.includes(entry.id),
            );
            if (entries.length === 0) return null;
            return (
              <Section key={group} title={group}>
                {entries.map((entry) => (
                  <NavRow
                    key={entry.id}
                    entry={entry}
                    active={entry.id === activeId}
                    pinned={false}
                    onTogglePin={() => setPins(togglePin(entry.id))}
                  />
                ))}
              </Section>
            );
          })}

          {recentlyVisited.length > 0 ? (
            <Section title="Recent">
              {recentlyVisited.map((entry) => (
                <Link
                  key={entry.id}
                  href={entry.href}
                  className="block truncate rounded-md px-2 py-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
                >
                  {entry.label}
                </Link>
              ))}
            </Section>
          ) : null}
        </nav>
        <div className="bo-sidebar-footer">SnapPOS · Back Office</div>
      </aside>

      <Launcher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bo-nav-section">
      <div className="bo-nav-heading">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function NavRow({
  entry,
  active,
  pinned,
  onTogglePin,
}: {
  entry: NavEntry;
  active: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  return (
    <div className={`bo-nav-row group ${active ? "active" : ""}`}>
      <Link href={entry.href} className="bo-nav-link">
        <span className="bo-nav-icon" aria-hidden><NavIcon entry={entry} /></span>
        <span className="truncate">{entry.label}</span>
      </Link>
      <button
        type="button"
        onClick={onTogglePin}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
        className={`bo-pin ${
          pinned ? "text-[var(--color-accent)]" : "text-transparent group-hover:text-[var(--color-text-muted)]"
        }`}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}

function NavIcon({ entry }: { entry: NavEntry }) {
  const common = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (entry.id === "dashboard") return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
  if (entry.id === "reports") return <svg {...common}><path d="M3 20h18M6 17v-6M12 17V5M18 17V9" /></svg>;
  if (entry.id === "orders") return <svg {...common}><path d="M4 8h16l-1 13H5L4 8ZM9 9V6a3 3 0 0 1 6 0v3" /></svg>;
  if (entry.group === "Catalog") return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9" /></svg>;
  if (entry.group === "Inventory") return <svg {...common}><path d="M4 5h16v4H4zM5 9v11h14V9M10 13h4" /></svg>;
  if (entry.group === "Purchasing") return <svg {...common}><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3ZM8 8h8M8 12h8M8 16h5" /></svg>;
  if (entry.group === "People") return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
  return <svg {...common}><path d="M3 10v4l11 4V6L3 10ZM14 8l5-3v14l-5-3M7 16l1 5h3" /></svg>;
}
