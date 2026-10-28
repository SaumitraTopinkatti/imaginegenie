// Theme preference: "system" (default) | "light" | "dark".
// The resolved value is written to <html data-theme>. public/theme-init.js
// applies the same rules before first paint (keep key + resolve order in step).
import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "imaginegenie-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
// <meta name="theme-color"> per resolved theme (browser UI chrome only).
const META_LIGHT = "#f5f4ef";
const META_DARK = "#0f1614";
/** Button order: System -> Light -> Dark -> System. */
export const NEXT_THEME: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };

function readStored(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function writeStored(pref: ThemePref) {
  try {
    if (pref === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage blocked: the choice still applies for this page view */
  }
}

const mq = window.matchMedia(DARK_QUERY);
let pref: ThemePref = readStored();
const listeners = new Set<() => void>();

function apply() {
  const dark = pref === "dark" || (pref === "system" && mq.matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = dark ? META_DARK : META_LIGHT;
}

function emit() {
  listeners.forEach((l) => l());
}

// "system" follows the OS live.
mq.addEventListener("change", () => {
  if (pref !== "system") return;
  apply();
  emit();
});

apply();

export function getThemePref(): ThemePref {
  return pref;
}

/** Advance System -> Light -> Dark -> System, persist, and re-apply. */
export function cycleThemePref() {
  pref = NEXT_THEME[pref];
  writeStored(pref);
  apply();
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, getThemePref, getThemePref);
}
