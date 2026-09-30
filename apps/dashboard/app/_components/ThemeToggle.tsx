"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";

type Theme = "dark" | "light";

/**
 * Flips between the dark and light themes and remembers the choice in this
 * browser. The page is already painted in the right theme by the boot script
 * in the root layout; this only reads what that script decided.
 */
export function ThemeToggle({ className = "bo-icon-button" }: { className?: string }) {
  // Null until mounted: the server cannot know, and guessing would render the
  // wrong icon for a moment on every light-theme page load.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);

  const flip = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("bo-theme", next);
    } catch {
      // Storage refused (private mode, policy): the switch still works for
      // this page, it just won't be remembered.
    }
    setTheme(next);
  };

  const label = theme === "light" ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button type="button" onClick={flip} className={className} aria-label={label} title={label}>
      <Icon name={theme === "light" ? "moon" : "sun"} />
    </button>
  );
}
