export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "instagram-saves-theme";

export function parseThemePreference(
  value: string | null | undefined,
): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** Inline boot script: set data-theme before paint to avoid flash/mismatch. */
export const THEME_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var dark=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=p==="system"?(dark?"dark":"light"):p;var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t;}catch(e){}})();`;
