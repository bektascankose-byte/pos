"use client";

import { usePathname } from "next/navigation";
import { activeEntry } from "@/lib/navigation";

/**
 * Where you are, in the top bar: the sidebar section, then the page. The same
 * lookup the sidebar uses to highlight its row, so the two can never disagree.
 */
export function Crumbs() {
  const entry = activeEntry(usePathname());

  if (!entry) {
    return (
      <div className="bo-crumbs">
        <span className="bo-crumbs-page">Back Office</span>
      </div>
    );
  }

  return (
    <nav className="bo-crumbs" aria-label="You are here">
      <span className="bo-crumbs-group">{entry.group}</span>
      <span className="bo-crumbs-sep" aria-hidden>/</span>
      <span className="bo-crumbs-page">{entry.label}</span>
    </nav>
  );
}
