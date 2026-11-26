// @ts-check
/**
 * Light, dark, or whatever the system says (the default). The choice lives in this browser only, and is put
 * on the page before anything is drawn, so a dark page never flashes white.
 */

const KEY = "snild.theme";

/** @typedef {"system" | "light" | "dark"} Theme */

/** @returns {Theme} */
export function savedTheme() {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system"; // storage may be switched off: the system's choice still works
  }
}

/** @param {Theme} theme */
export function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** @param {Theme} theme */
export function chooseTheme(theme) {
  applyTheme(theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // kept for this page only
  }
}
