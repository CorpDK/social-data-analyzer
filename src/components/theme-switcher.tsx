"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  type ThemePreference,
} from "@/lib/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function applyTheme(preference: ThemePreference) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(preference, prefersDark);
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved;
}

function readPreference(): ThemePreference {
  return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
}

function subscribe(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) onStoreChange();
  };
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    if (readPreference() === "system") applyTheme("system");
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("instagram-saves-theme-change", onStoreChange);
  media.addEventListener("change", onMedia);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("instagram-saves-theme-change", onStoreChange);
    media.removeEventListener("change", onMedia);
  };
}

export function ThemeSwitcher() {
  const preference = useSyncExternalStore(
    subscribe,
    readPreference,
    () => "system" as ThemePreference,
  );

  const select = useCallback((next: ThemePreference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
    window.dispatchEvent(new Event("instagram-saves-theme-change"));
  }, []);

  return (
    <div
      className="flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--chip)] p-1"
      role="group"
      aria-label="Color theme"
    >
      {OPTIONS.map((option) => {
        const selected = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={`${option.label} theme`}
            title={option.label}
            onClick={() => select(option.value)}
            className={`rounded-full px-2.5 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              selected
                ? "control-active"
                : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
