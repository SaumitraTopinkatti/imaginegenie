/** Tiny in-house router (D15/D16): three static paths, History API, no deps.
 *
 * Studio lives at `/`, References at `/references`, Inpaint at `/inpaint`
 * (optional `?src=gen:<id>` / `?src=ref:<id>` deep link). Hash routes were
 * rejected: skip links already use fragments (`#gallery`, `#ref-library`,
 * `#inpaint-main`). DOM-free — callers pass in pathname/search.
 */

export type TabId = "studio" | "refs" | "inpaint";

export const TAB_PATHS: Record<TabId, string> = {
  studio: "/",
  refs: "/references",
  inpaint: "/inpaint",
};

/** Path (case- and trailing-slash-insensitive) to tab. `null` = unknown. */
export function tabFromPath(pathname: string): TabId | null {
  const p = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (p === "/") return "studio";
  if (p === "/references") return "refs";
  if (p === "/inpaint") return "inpaint";
  return null;
}

export interface InpaintSrcRef {
  kind: "generation" | "reference";
  id: string;
}

/** `?src=gen:<id>` / `?src=ref:<id>` (D18). Anything else → null. */
export function parseInpaintSrc(search: string): InpaintSrcRef | null {
  try {
    const q = new URLSearchParams(search);
    const raw = q.get("src");
    if (!raw) return null;
    const m = /^(gen|ref):(.+)$/.exec(raw);
    if (!m || m[2] === "") return null;
    return { kind: m[1] === "gen" ? "generation" : "reference", id: m[2] };
  } catch {
    return null;
  }
}

/** Query string for the current inpaint source ("" when not deep-linkable). */
export function inpaintSrcParam(src: { kind: string; id?: string } | null): string {
  if (!src || !src.id) return "";
  if (src.kind === "generation") return `?src=gen:${encodeURIComponent(src.id)}`;
  if (src.kind === "reference") return `?src=ref:${encodeURIComponent(src.id)}`;
  return "";
}
