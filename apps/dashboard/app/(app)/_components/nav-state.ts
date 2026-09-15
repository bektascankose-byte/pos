"use client";

/**
 * Pinned and recently-visited pages, kept in `localStorage`.
 *
 * Per-browser rather than per-user on purpose: this ships to one shop on a
 * couple of machines, and a settings table plus an endpoint would be a lot of
 * moving parts for "which links sit at the top." Moving to a per-user API
 * later means changing this file and nothing else.
 *
 * Every access is guarded -- a private window, or a browser with site data
 * blocked, throws on the accessor rather than returning null.
 */

const PINS_KEY = "snappos.nav.pins";
const RECENTS_KEY = "snappos.nav.recents";
const MAX_RECENTS = 8;

function read(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Nothing to do about it, and it isn't worth failing navigation over.
  }
}

export function readPins(): string[] {
  return read(PINS_KEY);
}

/** Returns the new list so the caller can drop it straight into state. */
export function togglePin(id: string): string[] {
  const current = read(PINS_KEY);
  const next = current.includes(id) ? current.filter((pinned) => pinned !== id) : [...current, id];
  write(PINS_KEY, next);
  return next;
}

export function readRecents(): string[] {
  return read(RECENTS_KEY);
}

/** Most recent first, no duplicates, capped. */
export function pushRecent(id: string): string[] {
  const next = [id, ...read(RECENTS_KEY).filter((recent) => recent !== id)].slice(0, MAX_RECENTS);
  write(RECENTS_KEY, next);
  return next;
}
