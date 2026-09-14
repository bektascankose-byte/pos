"use client";

import { useState, type ReactNode } from "react";

/**
 * The first tab library/pattern in this app (grep confirmed zero prior art)
 * -- hand-rolled rather than adding a dependency, since all that's actually
 * needed is "show one of N sections, remember which is selected." Each
 * panel's DOM stays mounted (just hidden), so switching tabs never loses
 * in-progress input in a panel you're not currently looking at.
 */
export function Tabs({
  tabs,
  defaultTab,
}: {
  tabs: { id: string; label: string; content: ReactNode }[];
  defaultTab?: string;
}) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => setActive(tab.id)}
            className={
              active === tab.id
                ? "border-b-2 border-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent)]"
                : "border-b-2 border-transparent px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} hidden={active !== tab.id}>
          {tab.content}
        </div>
      ))}
    </div>
  );
}
