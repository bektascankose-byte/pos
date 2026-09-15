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
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2 px-3 py-4">
          <button
            type="button"
            onClick={() => setLauncherOpen(true)}
            title="All apps"
            aria-label="All apps"
            className="grid shrink-0 grid-cols-3 gap-1 rounded-md p-2.5 hover:bg-[var(--color-bg)]"
          >
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-muted)]" />
            ))}
          </button>
          <span className="text-lg font-semibold">SnapPOS</span>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mx-3 mb-3 flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
        >
          <span>Search…</span>
          <span className="text-xs">Ctrl K</span>
        </button>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 text-sm">
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
      </aside>

      <Launcher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2 pb-1 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
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
    <div
      className={`group flex items-center rounded-md ${
        active ? "bg-[var(--color-bg)] font-medium text-[var(--color-accent)]" : ""
      }`}
    >
      <Link href={entry.href} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
        <span aria-hidden>{entry.icon}</span>
        <span className="truncate">{entry.label}</span>
      </Link>
      <button
        type="button"
        onClick={onTogglePin}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
        className={`px-2 text-xs ${
          pinned ? "text-[var(--color-accent)]" : "text-transparent group-hover:text-[var(--color-text-muted)]"
        }`}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}
