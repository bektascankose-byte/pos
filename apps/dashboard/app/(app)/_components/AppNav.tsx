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
import { Icon, NavIcon } from "@/app/_components/icons";
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
      <button type="button" className="bo-mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Icon name="menu" /></button>
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
            <Icon name="bolt" fill="currentColor" stroke="none" />
          </button>
          <div className="min-w-0">
            <div className="bo-brand-name">SnapPOS</div>
            <div className="bo-brand-subtitle">Back Office</div>
          </div>
          <button type="button" className="bo-icon-button bo-sidebar-close ml-auto" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><Icon name="close" /></button>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="bo-search"
        >
          <Icon name="search" />
          <span>Search anything</span>
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
                <Link key={entry.id} href={entry.href} className="bo-nav-recent">
                  {entry.label}
                </Link>
              ))}
            </Section>
          ) : null}
        </nav>
        <div className="bo-sidebar-footer">
          <span className="bo-live-dot" aria-hidden />
          <span>SnapPOS Back Office</span>
          <button type="button" className="bo-icon-button ml-auto" style={{ width: 30, height: 30 }} onClick={() => setLauncherOpen(true)} aria-label="All apps" title="All apps">
            <Icon name="apps" size={15} />
          </button>
        </div>
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
        <span className="bo-nav-icon" aria-hidden><NavIcon id={entry.id} size={17} /></span>
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
        <Icon name="star" size={13} fill={pinned ? "currentColor" : "none"} />
      </button>
    </div>
  );
}
