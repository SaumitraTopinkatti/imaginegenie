// No-flash theme boot. Classic sync script in <head>, before the app bundle
// and first paint. Mirrors src/lib/theme.ts: stored "light"/"dark" wins,
// anything else follows prefers-color-scheme. External file on purpose:
// CSP is script-src 'self' (no inline scripts, no hashes).
(function () {
  var stored = null;
  try {
    stored = window.localStorage.getItem("imaginegenie-theme");
  } catch (e) {
    /* storage blocked: fall through to the OS preference */
  }
  var dark;
  if (stored === "light" || stored === "dark") {
    dark = stored === "dark";
  } else {
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      dark = false;
    }
  }
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0f1614" : "#f5f4ef");
})();
