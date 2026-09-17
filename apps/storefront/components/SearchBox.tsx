"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { ShopSuggestion } from "@snappos/contracts";

/**
 * Search with suggestions, as an ARIA combobox.
 *
 * The suggestions are an enhancement: the form submits to /search on Enter
 * with or without them, so the box works before JavaScript loads and for
 * anyone who ignores the list. Arrow keys move through suggestions, Enter
 * follows the highlighted one, Escape closes the list.
 */
export function SearchBox({ initial = "" }: { initial?: string }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState(initial);
  const [suggestions, setSuggestions] = useState<ShopSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = query.trim();
    if (term.length < 2) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/suggest?q=${encodeURIComponent(term)}`);
        if (!response.ok) return;
        setSuggestions((await response.json()) as ShopSuggestion[]);
        setActive(-1);
      } catch {
        setSuggestions([]);
      }
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const hrefFor = (s: ShopSuggestion) => {
    const slug = s.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
    if (s.kind === "product") return `/p/${s.id}/${slug}`;
    if (s.kind === "brand") return `/b/${s.id}/${slug}`;
    return `/c/${s.slug ?? ""}`;
  };

  const showList = open && suggestions.length > 0;

  return (
    <form
      role="search"
      action="/search"
      className="relative"
      onSubmit={(event) => {
        if (showList && active >= 0 && suggestions[active]) {
          event.preventDefault();
          setOpen(false);
          router.push(hrefFor(suggestions[active]!));
        }
      }}
    >
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search products, brands or a UPC
      </label>
      <input
        id={`${listId}-input`}
        name="q"
        type="search"
        autoComplete="off"
        className="field rounded-full pl-4 pr-24"
        placeholder="Search flavours, brands or scan a UPC"
        value={query}
        role="combobox"
        aria-expanded={showList}
        aria-controls={`${listId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-option-${active}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (!showList) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, suggestions.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, -1));
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <button type="submit" className="btn btn-quiet absolute right-1 top-1/2 -translate-y-1/2 min-h-[36px] px-3 text-sm">
        Search
      </button>

      {showList ? (
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label="Suggestions"
          className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.kind}-${suggestion.id}`}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2.5 text-sm ${
                index === active ? "bg-[var(--surface-sunk)]" : ""
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                setOpen(false);
                router.push(hrefFor(suggestion));
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span>
                {suggestion.label}
                {suggestion.kind !== "product" ? (
                  <span className="ml-2 text-xs text-[var(--muted)]">{suggestion.kind === "brand" ? "Brand" : "Category"}</span>
                ) : null}
              </span>
              {suggestion.detail ? <span className="text-xs text-[var(--muted)]">{suggestion.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
