"use client";

import { Icon } from "@/app/_components/icons";

/** Opens the command palette, which listens for this event in AppNav's tree. */
export function TopbarSearch() {
  return (
    <button
      type="button"
      className="bo-topbar-search"
      onClick={() => window.dispatchEvent(new Event("bo:open-palette"))}
    >
      <Icon name="search" />
      <span>Search items, customers, pages</span>
      <kbd className="bo-kbd">Ctrl K</kbd>
    </button>
  );
}
