import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ASPECT_RATIOS,
  MODEL,
  generateImage,
  maskKey,
  testKey,
  type Resolution,
} from "./lib/openrouter";
import {
  b64ToDataUrl,
  copyImageDataUrl,
  dataUrlToB64,
  downloadDataUrl,
  fileToDataUrl,
  isAccepted,
  makeThumb,
} from "./lib/images";
import {
  broadcastLibChanged,
  clearRecords,
  countBackupRecords,
  cryptoMode,
  decryptRecord,
  deleteRecord,
  encryptText,
  exportBackup,
  importBackup,
  initCrypto,
  listRawRecords,
  saveRecord,
  subscribeLibChanged,
  uid,
} from "./lib/secureStore";
import {
  AlertIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  DiceIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  GalleryIcon,
  HistoryIcon,
  KeyIcon,
  LockIcon,
  SearchIcon,
  SparkIcon,
  UploadIcon,
} from "./components/icons";
import ReferencesTab from "./components/ReferencesTab";
import DenoiseFrame from "./components/DenoiseFrame";
import logoUrl from "./assets/logo.png";

/* ---------- types & constants ---------- */

interface Generation {
  id: string;
  createdAt: number;
  prompt: string;
  aspectRatio: string;
  resolution: string;
  cost: number;
  mediaType: string;
  refCount: number;
  seed?: number;
  imageUrl: string;
  thumbUrl: string;
  refUrls: string[];
}

interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

const MAX_REFS = 14;
const MAX_PROMPT = 4000;
const MAX_COUNT = 4;

/** In-flight generation slot. The placeholder and its result share one card:
 *  loading -> (denoise exit) -> revealing (staggered fade-in) -> merged. */
interface Slot {
  key: number;
  gen: Generation | null;
  revealing: boolean;
  epoch: number;
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_COUNT, Math.max(1, Math.round(n)));
}

/* Concept shape picker: 8 visual slots up front, the rest behind "More shapes". */
const MAIN_ASPECTS = ["auto", "1:1", "4:5", "3:4", "9:16", "16:9", "3:2", "21:9"];

function ratioOf(label: string): number {
  if (label === "auto") return 1;
  const parts = label.split(":");
  const n = Number.parseFloat(parts[0]);
  const d = Number.parseFloat(parts[1]);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 1;
  return n / d;
}

function shapeBox(label: string): { w: number; h: number; dashed: boolean } {
  if (label === "auto") return { w: 22, h: 22, dashed: true };
  const rt = ratioOf(label);
  const max = 28;
  const w = rt >= 1 ? max : Math.max(6, Math.round(max * rt));
  const h = rt >= 1 ? Math.max(6, Math.round(max / rt)) : max;
  return { w, h, dashed: false };
}

/* Denoise loader grid: long side 16 cells, short side scaled (concept lib cards). */
function gridDims(label: string): { cols: number; rows: number } {
  const rt = ratioOf(label);
  const long = 16;
  return rt >= 1
    ? { cols: long, rows: Math.max(4, Math.round(long / rt)) }
    : { cols: Math.max(4, Math.round(long * rt)), rows: long };
}

function aspectCss(label: string): string {
  if (label === "auto") return "1 / 1";
  return label.split(":").join(" / ");
}
const PRICE_1K = 0.045;
const PRICE_2K = 0.09;
const KEY_SESSION = "imaginegenie.key";

type TabId = "studio" | "refs";
const TABS: Array<{ id: TabId; label: string }> = [
  { id: "studio", label: "Studio" },
  { id: "refs", label: "References" },
];

function loadKey(): string {
  try {
    const s = sessionStorage.getItem(KEY_SESSION);
    if (s) return s;
  } catch {
    /* noop */
  }
  try {
    const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
    return env.VITE_OPENROUTER_API_KEY || "";
  } catch {
    return "";
  }
}

function fmtCost(n: number): string {
  if (!isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

let toastId = 0;

interface GenCardProps {
  g: Generation;
  /** Staggered reveal after the denoise exit: image -> prompt -> chips -> foot. */
  reveal?: boolean;
  onOpen: (g: Generation) => void;
  onRetry: (g: Generation) => void;
  onCopy: (url: string) => void;
  onDownload: (g: Generation) => void;
  onDelete: (g: Generation) => void;
}

function GenCard({ g, reveal = false, onOpen, onRetry, onCopy, onDownload, onDelete }: GenCardProps) {
  const alt = g.prompt.slice(0, 80) || "Generated image";
  return (
    <article
      className={reveal ? "card reveal" : "card"}
      role="button"
      tabIndex={0}
      aria-label={`Open image: ${g.prompt.slice(0, 120) || "Generated image"}`}
      onClick={() => onOpen(g)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(g);
        }
      }}
    >
      <div className={reveal ? "thumb r-img" : "thumb"}>
        <img src={g.thumbUrl} alt={alt} loading="lazy" />
        <span className="cost-tag">{fmtCost(g.cost)}</span>
      </div>
      <div className="body">
        <div className={reveal ? "prompt-snippet r-prompt" : "prompt-snippet"}>{g.prompt}</div>
        <div className={reveal ? "meta r-meta" : "meta"}>
          <span className="tag">{g.aspectRatio}</span>
          <span className="tag">{g.resolution}</span>
          <span className="tag">{g.mediaType.replace("image/", "")}</span>
          {g.refCount > 0 && (
            <span className="tag hl">+{g.refCount} ref</span>
          )}
        </div>
        <div className={reveal ? "foot r-foot" : "foot"}>
          <span className="time">{fmtTime(g.createdAt)}</span>
          <span className="actions">
            <button
              type="button"
              className="icon-btn"
              title="Retry with same settings"
              aria-label="Retry with same settings"
              onClick={(e) => {
                e.stopPropagation();
                onRetry(g);
              }}
            >
              <HistoryIcon size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Copy image"
              aria-label="Copy image"
              onClick={(e) => {
                e.stopPropagation();
                onCopy(g.imageUrl);
              }}
            >
              <CopyIcon size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Download PNG"
              aria-label="Download PNG"
              onClick={(e) => {
                e.stopPropagation();
                onDownload(g);
              }}
            >
              <DownloadIcon size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Delete"
              aria-label="Delete image"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(g);
              }}
            >
              <DeleteIcon size={15} />
            </button>
          </span>
        </div>
      </div>
    </article>
  );
}

export default function App() {
  /* ----- api key ----- */
  const [apiKey, setApiKey] = useState<string>(() => loadKey());
  const [showKey, setShowKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ text: string; kind: "ok" | "err" | "" }>({
    text: "",
    kind: "",
  });
  const [testing, setTesting] = useState(false);

  /* ----- composer ----- */
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<string>("16:9");
  const [resolution, setResolution] = useState<Resolution>("1K");
  const [seedStr, setSeedStr] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /* ----- generation ----- */
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [countStr, setCountStr] = useState("1");
  const [error, setError] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const epochRef = useRef(0);
  const [genElapsed, setGenElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const progressTimer = useRef<number | null>(null);
  const progressDone = useRef(0);

  /* ----- library ----- */
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [alg, setAlg] = useState("…");
  const [search, setSearch] = useState("");
  const [aspectFilter, setAspectFilter] = useState("all");
  const [lightbox, setLightbox] = useState<Generation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Generation | null>(null);
  const [clearStep, setClearStep] = useState<0 | 1 | 2>(0);
  const [clearText, setClearText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [viewRef, setViewRef] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const clearCancelRef = useRef<HTMLButtonElement>(null);
  const clearInputRef = useRef<HTMLInputElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const touchY = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const importInput = useRef<HTMLInputElement>(null);

  /* ----- tabs ----- */
  const [tab, setTab] = useState<TabId>("studio");
  const [referenceCount, setReferenceCount] = useState(0);
  const [showMoreShapes, setShowMoreShapes] = useState(false);
  const [libMenuOpen, setLibMenuOpen] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);

  /** Header key pill: jump to the composer key field and focus it. */
  const focusKey = () => {
    if (tab !== "studio") {
      setTab("studio");
      window.setTimeout(() => {
        if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(true);
        keyInputRef.current?.focus();
        keyInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      return;
    }
    if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(true);
    requestAnimationFrame(() => {
      keyInputRef.current?.focus();
      keyInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  /* ----- totals (derived in-memory; the old write-only localStorage copy is gone) ----- */
  const totals = useMemo(() => {
    const spend = generations.reduce((s, g) => s + (g.cost || 0), 0);
    const refTotal = generations.reduce((s, g) => s + (g.refCount || 0), 0);
    return {
      images: generations.length,
      spend,
      avg: generations.length ? spend / generations.length : 0,
      refs: refTotal,
    };
  }, [generations]);

  /* ----- library reload: re-list IDB + decrypt (used by boot/import/clear/cross-tab) ----- */
  const reloadLibrary = useCallback(
    async (opts?: { silent?: boolean }): Promise<number> => {
      try {
        const raw = await listRawRecords();
        const out: Generation[] = [];
        for (const r of raw) {
          try {
            const { imageUrl, thumbUrl, refUrls } = await decryptRecord(r);
            out.push({
              id: r.id,
              createdAt: r.createdAt,
              prompt: r.prompt,
              aspectRatio: r.aspectRatio,
              resolution: r.resolution,
              cost: r.cost,
              mediaType: r.mediaType,
              refCount: r.refCount,
              seed: r.seed,
              imageUrl,
              thumbUrl,
              refUrls,
            });
          } catch {
            /* skip corrupt record */
          }
        }
        setGenerations(out);
        return out.length;
      } catch {
        if (!opts?.silent) pushToast("err", "Could not open encrypted library.");
        return -1;
      }
    },
    [pushToast]
  );

  /* ----- boot: key env note + decrypt library ----- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mode = await initCrypto();
      if (cancelled) return;
      setAlg(mode === "AES-GCM-256" ? "AES-GCM-256" : cryptoMode());
      await reloadLibrary({ silent: true });
      if (!cancelled) setHistoryLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadLibrary]);

  useEffect(() => {
    try {
      if (apiKey) sessionStorage.setItem(KEY_SESSION, apiKey);
      else sessionStorage.removeItem(KEY_SESSION);
    } catch {
      /* noop */
    }
  }, [apiKey]);

  /* ----- multi-tab: another tab mutated the library -> re-list + reload ----- */
  const lastFocusReload = useRef(0);
  useEffect(() => {
    const onRemote = () => {
      void reloadLibrary({ silent: true }).then((n) => {
        if (n >= 0) pushToast("info", "Library changed in another tab — reloaded");
      });
    };
    const unsubscribe = subscribeLibChanged(onRemote);
    const onFocus = () => {
      // Debounced silent refresh: catches mutations missed while unfocused
      // without hammering IDB on rapid focus flapping.
      const now = Date.now();
      if (now - lastFocusReload.current < 2000) return;
      lastFocusReload.current = now;
      void reloadLibrary({ silent: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reloadLibrary, pushToast]);

  /* ----- refs ----- */
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      if (refs.length + list.length > MAX_REFS) {
        pushToast("err", `Limit is ${MAX_REFS} references. Remove some first.`);
        return;
      }
      const bad = list.filter((f) => !isAccepted(f));
      if (bad.length > 0) {
        pushToast("err", "Only PNG, JPG or WebP files.");
        return;
      }
      try {
        const urls = await Promise.all(list.map((f) => fileToDataUrl(f)));
        setRefs((r) => [...r, ...urls].slice(0, MAX_REFS));
      } catch (e) {
        pushToast("err", e instanceof Error ? e.message : "Could not read images.");
      }
    },
    [refs.length, pushToast]
  );

  /* ----- paste images from clipboard straight into the composer tray (Studio tab only) ----- */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (tab !== "studio") return; // References tab has its own paste handler for the library
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return; // text-only paste: stay out entirely
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return; // no image items: never preventDefault
      void addFiles(images);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addFiles, tab]);

  const removeRef = (i: number) => setRefs((r) => r.filter((_, x) => x !== i));
  const moveRef = (i: number, dir: -1 | 1) =>
    setRefs((r) => {
      const j = i + dir;
      if (j < 0 || j >= r.length) return r;
      const copy = [...r];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const randomSeed = () => setSeedStr(String(Math.floor(Math.random() * 2147483647)));

  /* ----- key test ----- */
  const doTest = async () => {
    if (!apiKey.trim()) {
      setKeyMsg({ text: "Paste your OpenRouter key first.", kind: "err" });
      return;
    }
    setTesting(true);
    setKeyMsg({ text: "", kind: "" });
    try {
      const msg = await testKey(apiKey.trim());
      setKeyMsg({ text: msg, kind: "ok" });
    } catch (e) {
      setKeyMsg({ text: e instanceof Error ? e.message : "Connection failed.", kind: "err" });
    } finally {
      setTesting(false);
    }
  };

  /* ----- generate ----- */
  const doGenerate = useCallback(async () => {
    if (generating || clearing) return;
    const key = apiKey.trim();
    if (!key) {
      setError("Add your OpenRouter API key first (left panel).");
      return;
    }
    if (!prompt.trim()) {
      setError("Describe the image first.");
      return;
    }
    let seed: number | undefined;
    if (seedStr.trim() !== "") {
      const n = Number(seedStr.trim());
      if (!Number.isInteger(n) || n < 0) {
        setError("Seed must be a whole number (0 or above).");
        return;
      }
      seed = n;
    }
    setError("");
    const count = clampCount(Number.parseInt(countStr, 10) || 1);
    setGenerating(true);
    // One slot per requested image. The placeholder and its result share one
    // card: saved images attach to a slot and merge in only after the reveal.
    epochRef.current += 1;
    const epoch = epochRef.current;
    setSlots(
      Array.from({ length: count }, (_, i) => ({
        key: Date.now() + i,
        gen: null,
        revealing: false,
        epoch,
      }))
    );
    setProgress(6);
    progressDone.current = 0;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 92) {
          // Hold at ~92% while the API is still working; completions push the floor up.
          const floor = 6 + (progressDone.current / count) * 86;
          return Math.max(p, Math.min(floor, 92));
        }
        const floor = 6 + (progressDone.current / count) * 86;
        return Math.min(92, Math.max(p + Math.max(1, (92 - p) / 14), floor));
      });
    }, 350);
    const params = { prompt: prompt.trim(), aspect_ratio: aspect, resolution, refs, seed };
    try {
      // Fan out N parallel n=1 requests sharing one AbortController, so one
      // failure (or cancel) never kills the other slots. Single attempt each.
      const bump = () => {
        progressDone.current += 1;
        const done = progressDone.current;
        setProgress((p) => Math.max(p, 6 + (done / count) * 86));
      };
      const outcomes = await Promise.allSettled(
        Array.from({ length: count }, () =>
          generateImage(key, params, ctrl.signal).then(
            (v) => {
              bump();
              return v;
            },
            (e) => {
              bump();
              throw e;
            }
          )
        )
      );
      const saved: Generation[] = [];
      let firstError = "";
      for (const o of outcomes) {
        if (o.status === "fulfilled") {
          const res = o.value;
          const fullUrl = b64ToDataUrl(res.b64, res.mediaType);
          let thumb = fullUrl;
          try {
            thumb = await makeThumb(fullUrl);
          } catch {
            thumb = fullUrl;
          }
          const [imageEnc, thumbEnc, refsEnc] = await Promise.all([
            encryptText(fullUrl),
            encryptText(thumb),
            Promise.all(refs.map((u) => encryptText(u))),
          ]);
          const gen: Generation = {
            id: uid(),
            createdAt: Date.now(),
            prompt: prompt.trim(),
            aspectRatio: aspect,
            resolution,
            cost: res.cost,
            mediaType: res.mediaType,
            refCount: refs.length,
            seed,
            imageUrl: fullUrl,
            thumbUrl: thumb,
            refUrls: [...refs],
          };
          await saveRecord({
            id: gen.id,
            createdAt: gen.createdAt,
            prompt: gen.prompt,
            aspectRatio: gen.aspectRatio,
            resolution: gen.resolution,
            cost: gen.cost,
            mediaType: gen.mediaType,
            refCount: gen.refCount,
            seed: gen.seed,
            imageEnc,
            thumbEnc,
            refsEnc,
          });
          // Hold the result on its slot: it merges into the library only after
          // the placeholder's exit + reveal sequence finishes in the same card.
          setSlots((prev) => {
            const idx = prev.findIndex((s) => s.gen === null);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], gen };
            return next;
          });
          saved.push(gen);
        } else if (!firstError) {
          firstError =
            o.reason instanceof DOMException && o.reason.name === "AbortError"
              ? ""
              : o.reason instanceof Error
                ? o.reason.message
                : "Generation failed.";
        }
      }
      const aborted = ctrl.signal.aborted;
      setProgress(96);
      // NOTE: no setGenerations here — each saved image merges into the
      // library from its own slot after the reveal sequence (see slotCleaned).
      if (aborted) {
        setError("Cancelled.");
      } else if (saved.length === 0) {
        setError(firstError || "Generation failed.");
      } else if (saved.length < count) {
        pushToast(
          "err",
          `Saved ${saved.length} of ${count} images. ${count - saved.length} failed: ${firstError || "unknown error"}`
        );
      } else {
        setProgress(100);
        const total = saved.reduce((s, g) => s + g.cost, 0);
        pushToast("ok", `Image ready — ${fmtCost(total)} this call.`);
        if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(false);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("Cancelled.");
      } else {
        setError(e instanceof Error ? e.message : "Generation failed.");
      }
    } finally {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      abortRef.current = null;
      setGenerating(false);
      window.setTimeout(() => setProgress(0), 900);
    }
  }, [generating, clearing, apiKey, prompt, aspect, resolution, refs, seedStr, countStr, pushToast]);

  const generateRef = useRef(doGenerate);
  generateRef.current = doGenerate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        generateRef.current();
      }
      if (e.key === "Escape") {
        setLightbox(null);
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ----- mobile drawer: auto-close on desktop, scroll lock, light focus trap ----- */
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    if (!window.matchMedia("(max-width: 900px)").matches) {
      setDrawerOpen(false);
      return;
    }
    document.body.style.overflow = "hidden";
    const aside = asideRef.current;
    aside?.querySelector("textarea")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !aside) return;
      const items = Array.from(
        aside.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    aside?.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      aside?.removeEventListener("keydown", onKey);
      peekRef.current?.focus({ preventScroll: true });
    };
  }, [drawerOpen]);

  /* ----- delete confirmation: Esc cancels, focus starts on Cancel ----- */
  useEffect(() => {
    if (!pendingDelete) return;
    cancelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPendingDelete(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pendingDelete]);

  /* ----- clear-all double confirm: Esc cancels, focus follows the step ----- */
  useEffect(() => {
    if (clearStep === 0) return;
    if (clearStep === 1) clearCancelRef.current?.focus({ preventScroll: true });
    else clearInputRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        abortClear();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [clearStep]);

  const cancelGen = () => abortRef.current?.abort();

  /* ----- generation elapsed clock for the denoise placeholder caption ----- */
  useEffect(() => {
    if (!generating) {
      setGenElapsed(0);
      return;
    }
    setGenElapsed(0);
    const t0 = Date.now();
    const id = window.setInterval(
      () => setGenElapsed(Math.floor((Date.now() - t0) / 1000)),
      500
    );
    return () => window.clearInterval(id);
  }, [generating]);

  /* ----- slot lifecycle: loader exit -> staggered reveal -> merge ----- */
  const slotCleaned = (key: number) => {
    const s = slots.find((x) => x.key === key);
    if (!s) return;
    if (!s.gen) {
      // Failed or cancelled: no result to reveal, drop the placeholder.
      setSlots((prev) => prev.filter((x) => x.key !== key));
      return;
    }
    const gen = s.gen;
    const epoch = s.epoch;
    setSlots((prev) => prev.map((x) => (x.key === key ? { ...x, revealing: true } : x)));
    // Merge once the staggered reveal (image -> prompt -> chips -> foot) finishes.
    window.setTimeout(() => {
      if (epochRef.current !== epoch) return; // library was cleared meanwhile
      setGenerations((g) => [gen, ...g]);
      broadcastLibChanged();
      setSlots((prev) => prev.filter((x) => x.key !== key));
    }, 1100);
  };

  const copyImage = useCallback(
    async (dataUrl: string) => {
      try {
        await copyImageDataUrl(dataUrl);
        pushToast("ok", "Image copied.");
      } catch {
        pushToast("err", "Copy failed in this browser.");
      }
    },
    [pushToast]
  );

  /* ----- library ops ----- */
  const delGen = async (id: string) => {
    setGenerations((g) => g.filter((x) => x.id !== id));
    if (lightbox?.id === id) setLightbox(null);
    try {
      await deleteRecord(id);
      broadcastLibChanged();
    } catch {
      pushToast("err", "Delete failed in storage.");
    }
  };

  const abortClear = () => {
    setClearStep(0);
    setClearText("");
  };

  const clearAll = async () => {
    if (generations.length === 0 || clearing) return;
    setClearing(true);
    setGenerations([]);
    setLightbox(null);
    // Drop any in-flight slots and invalidate their pending merges.
    epochRef.current += 1;
    setSlots([]);
    try {
      await clearRecords();
      // Confirm against storage before claiming empty: another tab may have
      // written concurrently. Reconcile instead of showing a stale empty.
      const remaining = await listRawRecords();
      if (remaining.length === 0) {
        pushToast("ok", "Library cleared.");
      } else {
        await reloadLibrary({ silent: true });
      }
      broadcastLibChanged();
    } catch {
      pushToast("err", "Clear failed in storage.");
      await reloadLibrary({ silent: true });
    } finally {
      setClearing(false);
    }
  };

  const retryGen = (g: Generation) => {
    setPrompt(g.prompt);
    setAspect(g.aspectRatio);
    setResolution((g.resolution === "2K" ? "2K" : "1K") as Resolution);
    setSeedStr(g.seed !== undefined ? String(g.seed) : "");
    const restored = (g.refUrls ?? []).slice(0, MAX_REFS);
    setRefs(restored);
    setLightbox(null);
    setViewRef(null);
    if (restored.length > 0) {
      pushToast("info", `Settings + ${restored.length} reference(s) restored.`);
    } else {
      pushToast("info", "Settings restored. Add references again if needed.");
    }
    if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(true);
    requestAnimationFrame(() => {
      asideRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  const doExport = async () => {
    try {
      const json = await exportBackup();
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `imaginegenie-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      pushToast("ok", "Encrypted backup downloaded.");
    } catch {
      pushToast("err", "Export failed.");
    }
  };

  const doImportFile = async (f: File) => {
    if (clearing) return;
    try {
      const text = await f.text();
      let inFile: number;
      try {
        inFile = countBackupRecords(text);
      } catch {
        pushToast("err", "Import failed — not a valid backup.");
        return;
      }
      pushToast("info", `${generations.length} in library, ${inFile} in file.`);
      const n = await importBackup(text);
      const extra = n.references > 0 ? ` (${n.references} reference(s))` : "";
      pushToast("ok", `Imported ${n.records} generation(s)${extra}. Reloading…`);
      await reloadLibrary({ silent: true });
      broadcastLibChanged();
    } catch {
      pushToast("err", "Import failed — not a valid backup.");
    }
  };

  function refsKb(urls: string[]): number {
    const b64len = urls.reduce((s, u) => s + dataUrlToB64(u).length, 0);
    return Math.round(((b64len * 3) / 4 / 1024) * 10) / 10;
  }

  const reuseRefs = (urls: string[]) => {
    if (urls.length === 0) return;
    const room = MAX_REFS - refs.length;
    if (room <= 0) {
      pushToast("err", `Reference tray is full (${MAX_REFS}). Remove some first.`);
      return;
    }
    const add = urls.slice(0, room);
    setRefs((cur) => [...cur, ...add].slice(0, MAX_REFS));
    if (add.length < urls.length) {
      pushToast("info", `Added ${add.length} of ${urls.length} — tray holds ${MAX_REFS}.`);
    } else if (add.length === 1) {
      pushToast("ok", "Reference loaded into composer.");
    } else {
      pushToast("ok", `${add.length} references loaded into composer.`);
    }
    setLightbox(null);
    setViewRef(null);
    if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(true);
    requestAnimationFrame(() => {
      asideRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  /** From the References tab: load into the composer and jump back to Studio. */
  const useReference = (imageUrl: string) => {
    setTab("studio");
    reuseRefs([imageUrl]);
  };

  /* switching tabs tears down composer-scoped UI */
  useEffect(() => {
    setDrawerOpen(false);
    setLightbox(null);
  }, [tab]);

  const filtered = useMemo(() => {    const q = search.trim().toLowerCase();
    return generations.filter((g) => {
      if (aspectFilter !== "all" && g.aspectRatio !== aspectFilter) return false;
      if (q && !g.prompt.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [generations, search, aspectFilter]);

  const estPrice = resolution === "2K" ? PRICE_2K : PRICE_1K;
  const countNum = clampCount(Number.parseInt(countStr, 10) || 1);
  const estTotal = (estPrice + refs.length * 0.003) * countNum;
  const moreAspects = useMemo(
    () => ASPECT_RATIOS.filter((a) => !MAIN_ASPECTS.includes(a)),
    []
  );
  const loaderDims = gridDims(aspect);
  const loaderAspect = aspectCss(aspect);

  /** One shared card per slot: loader first, then the staggered reveal of its
   *  own result. The slot merges into the library only after the reveal. */
  const slotCards = slots.map((s) =>
    s.gen && s.revealing ? (
      <GenCard
        key={`slot-${s.key}`}
        g={s.gen}
        reveal
        onOpen={setLightbox}
        onRetry={retryGen}
        onCopy={(url) => void copyImage(url)}
        onDownload={(gen) =>
          downloadDataUrl(gen.imageUrl, `imaginegenie-${gen.id.slice(0, 8)}.png`)
        }
        onDelete={setPendingDelete}
      />
    ) : (
      <article className="card pending-card" key={`slot-${s.key}`}>
        <DenoiseFrame
          seed={s.key}
          cols={loaderDims.cols}
          rows={loaderDims.rows}
          aspect={loaderAspect}
          done={!generating}
          onClean={() => slotCleaned(s.key)}
        />
        <div className="body">
          <div className={generating ? "gen-caption" : "gen-caption fading"}>
            <span className="gen-status">Generating · {genElapsed}s</span>
            <span className="gen-meta">
              {aspect} · {resolution}
            </span>
          </div>
        </div>
      </article>
    )
  );

  return (
    <div>
      <a href={tab === "studio" ? "#gallery" : "#ref-library"} className="skip-link">
        {tab === "studio" ? "Skip to gallery" : "Skip to references"}
      </a>
      {/* header */}
      <header className="header">
        <h1 className="visually-hidden">ImagineGenie — AI image studio</h1>
        <div className="header-inner">
          <div className="logo">
            <img
              className="logo-img"
              src={logoUrl}
              alt="ImagineGenie logo"
              width={36}
              height={36}
            />
            <div>
              <div className="brand-name">
                Imagine<span className="genie">Genie</span>
              </div>
              <div className="brand-sub">AI image studio</div>
            </div>
          </div>
          <nav className="nav-pill" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="tab"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === "refs" && referenceCount > 0 && (
                  <span className="tab-count">{referenceCount}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="header-actions">
            <span className="model-btn" title={MODEL}>
              <span className="dot" aria-hidden="true" />
              <span>Seedream 5.0 Pro</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5D6966" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </span>
            <button
              type="button"
              className={apiKey.trim() ? "key-btn" : "key-btn not-set"}
              onClick={focusKey}
              title={apiKey.trim() ? "API key connected — edit in composer" : "Add your OpenRouter API key"}
            >
              <KeyIcon size={15} />
              <span className="key-mask">{apiKey.trim() ? maskKey(apiKey.trim()) : "no key"}</span>
              <span className="key-state">{apiKey.trim() ? "Connected" : "Not set"}</span>
            </button>
          </div>
        </div>
      </header>

      {tab === "studio" && (
        <div className="shell">
          {/* composer */}
          <aside
            ref={asideRef}
            className={drawerOpen ? "panel composer open" : "panel composer"}
            aria-label="Composer"
          >
            {/* mobile sheet grab handle */}
            <div
              className="sheet-grab"
              onTouchStart={(e) => {
                touchY.current = e.touches[0].clientY;
              }}
              onTouchEnd={(e) => {
                if (touchY.current == null) return;
                const dy = e.changedTouches[0].clientY - touchY.current;
                touchY.current = null;
                if (dy > 70) setDrawerOpen(false);
              }}
            >
              <span className="grab-handle" aria-hidden="true" />
              <span className="grab-row">
                <span className="grab-label">
                  <SparkIcon size={15} /> New image
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Close panel"
                  onClick={() => setDrawerOpen(false)}
                >
                  <CloseIcon size={15} />
                </button>
              </span>
            </div>
            <div className="composer-top">
            <div className="composer-head">
            <h2 className="composer-title">
              New <span className="title-serif">image</span>
            </h2>
            <span className="composer-model">{MODEL}</span>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Prompt</span>
                <span className="count">
                  {prompt.length}/{MAX_PROMPT}
                </span>
              </div>
              <textarea
                className="prompt"
                aria-label="Prompt"
                placeholder="A cozy cabin in a snowy forest at dusk, warm windows, illustration…"
                value={prompt}
                maxLength={MAX_PROMPT}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    generateRef.current();
                  }
                }}
              />
            </div>

            <div className="field">
              <div className="field-label">
                <span id="shape-label">Shape</span>
                <span className="count">{aspect}</span>
              </div>
              <div className="shape-grid" role="group" aria-labelledby="shape-label">
                {MAIN_ASPECTS.map((a) => {
                  const sel = aspect === a;
                  const box = shapeBox(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      className="shape-btn"
                      aria-pressed={sel}
                      aria-label={`Aspect ratio ${a}`}
                      onClick={() => setAspect(a)}
                    >
                      <span
                        aria-hidden="true"
                        className="box"
                        style={{
                          width: box.w,
                          height: box.h,
                          border: `1.5px ${box.dashed ? "dashed" : "solid"} ${sel ? "#0A7A6B" : "#8E9895"}`,
                          background: sel ? "#E1F1ED" : "transparent",
                        }}
                      />
                      <span className="lbl">{a}</span>
                    </button>
                  );
                })}
              </div>
              {showMoreShapes && (
                <div className="shape-more">
                  {moreAspects.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={aspect === a ? "chip active" : "chip"}
                      aria-pressed={aspect === a}
                      onClick={() => setAspect(a)}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="shape-toggle"
                onClick={() => setShowMoreShapes((s) => !s)}
              >
                {showMoreShapes ? "Fewer shapes" : `More shapes (${moreAspects.length})`}
              </button>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Resolution</span>
              </div>
              <div className="seg">
                <button
                  type="button"
                  className={resolution === "1K" ? "active" : ""}
                  aria-pressed={resolution === "1K"}
                  onClick={() => setResolution("1K")}
                >
                  1K<small>$0.045 / image</small>
                </button>
                <button
                  type="button"
                  className={resolution === "2K" ? "active" : ""}
                  aria-pressed={resolution === "2K"}
                  onClick={() => setResolution("2K")}
                >
                  2K<small>$0.09 / image</small>
                </button>
              </div>
              <div className="price-hint">
                Estimate: <b>{fmtCost(estTotal)}</b> with {refs.length} ref(s)
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <div className="field-label">
                  <span id="count-label">Count</span>
                </div>
                <div className="stepper" role="group" aria-labelledby="count-label">
                  <button
                    type="button"
                    aria-label="Fewer images"
                    disabled={countNum <= 1 || clearing}
                    onClick={() => setCountStr(String(clampCount(countNum - 1)))}
                  >
                    −
                  </button>
                  <span className="val" aria-live="polite">
                    {countNum}
                  </span>
                  <button
                    type="button"
                    aria-label="More images"
                    disabled={countNum >= MAX_COUNT || clearing}
                    onClick={() => setCountStr(String(clampCount(countNum + 1)))}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="field">
                <div className="field-label">
                  <label htmlFor="seed">
                    Seed <span className="opt">optional</span>
                  </label>
                </div>
                <div className="seed-row">
                  <input
                    id="seed"
                    type="number"
                    min={0}
                    step={1}
                    aria-label="Seed (optional)"
                    placeholder="Random"
                    value={seedStr}
                    onChange={(e) => setSeedStr(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-small"
                    title="Random seed"
                    aria-label="Random seed"
                    onClick={randomSeed}
                  >
                    <DiceIcon size={15} />
                  </button>
                </div>
              </div>
            </div>

            <div className="field">
              <div className="field-label">
                <span>References</span>
                <span className="count">
                  {refs.length} / {MAX_REFS} · $0.003 each
                </span>
              </div>
              <div
                className={dragOver ? "dropzone over" : "dropzone"}
                role="button"
                tabIndex={0}
                aria-label="Upload reference images"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInput.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void addFiles(e.dataTransfer.files);
                }}
              >
                <span className="dz-ico" aria-hidden="true">
                  <UploadIcon size={16} />
                </span>
                <div>
                  <div className="dz-title">Drop, browse or paste images</div>
                  <div className="dz-sub">PNG, JPG or WebP · resized to 2048px max</div>
                </div>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="ref-slots" aria-hidden="true">
                {Array.from({ length: MAX_REFS }).map((_, i) => (
                  <span key={i} className={i < refs.length ? "full" : undefined} />
                ))}
              </div>
              <div>
                <button
                  type="button"
                  className="lib-link"
                  onClick={() => setTab("refs")}
                >
                  <GalleryIcon size={14} /> Open reference library
                  {referenceCount > 0 && <span className="tab-count">{referenceCount}</span>}
                </button>
              </div>
              {refs.length > 0 && (
                <div className="ref-grid">
                  {refs.map((u, i) => (
                    <div className="ref-thumb" key={`ref-${u.length}-${u.slice(22, 46)}`}>
                      <img src={u} alt={`Reference ${i + 1}`} />
                      <span className="idx">#{i + 1}</span>
                      <button
                        type="button"
                        className="rm"
                        title="Remove"
                        aria-label={`Remove reference ${i + 1}`}
                        onClick={() => removeRef(i)}
                      >
                        <CloseIcon size={11} />
                      </button>
                      <span className="mv">
                        <button
                          type="button"
                          title="Move left"
                          aria-label="Move reference left"
                          onClick={() => moveRef(i, -1)}
                        >
                          <ChevronLeftIcon size={12} />
                        </button>
                        <button
                          type="button"
                          title="Move right"
                          aria-label="Move reference right"
                          onClick={() => moveRef(i, 1)}
                        >
                          <ChevronRightIcon size={12} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <div className="field-label">
                <span>OpenRouter API key</span>
                {apiKey && <span className="count">{maskKey(apiKey.trim())}</span>}
              </div>
              <div className="key-row">
                <input
                  id="api-key"
                  ref={keyInputRef}
                  type={showKey ? "text" : "password"}
                  aria-label="OpenRouter API key"
                  placeholder="sk-or-v1-…"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="eye"
                  title={showKey ? "Hide key" : "Show key"}
                  aria-label={showKey ? "Hide key" : "Show key"}
                  onClick={() => setShowKey((s) => !s)}
                >
                  {showKey ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={testing}
                  onClick={() => void doTest()}
                >
                  {testing ? "…" : "Test"}
                </button>
              </div>
              <div className={keyMsg.kind === "err" ? "key-status err" : "key-status ok"}>
                {keyMsg.text}
              </div>
              <div className="key-meta">
                <KeyIcon size={13} />
                <span>Key stays in memory + this tab only.</span>
              </div>
            </div>

            </div>
            <div className="gen-foot">
            <div className="gen-est">
              <span className="lbl">Estimate</span>
              <span className="val">
                {countNum} × {resolution} {fmtCost(estPrice)} + {refs.length} refs ={" "}
                {fmtCost(estTotal)}
              </span>
            </div>
            <button
              type="button"
              className="gen-btn"
              disabled={generating || clearing}
              onClick={() => void doGenerate()}
            >
              {generating ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Working… {Math.round(progress)}%
                </>
              ) : (
                <>
                  <SparkIcon size={18} /> Generate · {fmtCost(estTotal)}
                </>
              )}
            </button>
            {generating && (
              <>
                <div
                  className="progress"
                  role="progressbar"
                  aria-label="Generation progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                >
                  <i style={{ width: `${progress}%` }} />
                </div>
                <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
                  <button type="button" className="btn btn-small btn-ghost" onClick={cancelGen}>
                    <CloseIcon size={13} /> Cancel
                  </button>
                </div>
              </>
            )}
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            <span className="kbd-hint">
              <kbd>Ctrl</kbd> + <kbd>Enter</kbd> from the prompt
            </span>
            </div>
          </aside>

          <main className="main-col">
            {/* metrics */}
            <section className="metrics" aria-label="Session metrics">
              <div
                className="metric main"
                role="group"
                aria-label={`${totals.images} images in encrypted library`}
              >
                <span className="kicker">IMAGES</span>
                <div className="row-between">
                  <span className="big">{totals.images}</span>
                  <span className="enc">
                    <LockIcon size={14} /> in encrypted Library
                  </span>
                </div>
              </div>
              <div className="metric side">
                <span className="kicker">SESSION SPEND</span>
                <span>
                  <span className="mid">{fmtCost(totals.spend)}</span>
                  <span className="sub">sum of usage.cost</span>
                </span>
              </div>
              <div className="metric side">
                <span className="kicker">REFS USED</span>
                <span>
                  <span className="mid">{totals.refs}</span>
                  <span className="sub">$0.003 per extra image</span>
                </span>
              </div>
            </section>

            {/* gallery */}
          <section id="gallery" className="panel gallery" aria-label="Gallery">
            <div className="gallery-bar">
              <div className="search">
                <span className="icon">
                  <SearchIcon size={16} />
                </span>
                <input
                  type="text"
                  aria-label="Search prompts"
                  placeholder="Search prompts"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="aspect-select"
                value={aspectFilter}
                onChange={(e) => setAspectFilter(e.target.value)}
                title="Filter by shape"
                aria-label="Filter by shape"
              >
                <option value="all">All shapes</option>
                {ASPECT_RATIOS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <div className="menu-wrap">
                <button
                  type="button"
                  className="btn btn-small"
                  aria-expanded={libMenuOpen}
                  onClick={() => setLibMenuOpen((o) => !o)}
                >
                  Library
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5D6966" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {libMenuOpen && (
                  <div className="menu-pop" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setLibMenuOpen(false);
                        void doExport();
                      }}
                    >
                      <DownloadIcon size={15} /> Back up library
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setLibMenuOpen(false);
                        importInput.current?.click();
                      }}
                    >
                      <UploadIcon size={15} /> Restore from backup
                    </button>
                    <span className="sep" aria-hidden="true" />
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={generations.length === 0 || clearing}
                      onClick={() => {
                        setLibMenuOpen(false);
                        setClearText("");
                        setClearStep(1);
                      }}
                    >
                      <DeleteIcon size={15} /> Clear library
                    </button>
                  </div>
                )}
              </div>
            </div>
            <input
              ref={importInput}
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImportFile(f);
                e.target.value = "";
              }}
            />

            {historyLoading ? (
              <div className="grid">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div className="skel" key={i}>
                    <div className="ph" />
                    <div className="ln" />
                  </div>
                ))}
              </div>
            ) : slots.length > 0 && generations.length === 0 && slots.length === 1 ? (
              <div className="panel gallery-hero" key={`hero-${slots[0].key}`}>
                {slots[0].gen && slots[0].revealing ? (
                  <div className="reveal">
                    <img
                      className="r-img hero-img"
                      src={slots[0].gen.thumbUrl}
                      alt={slots[0].gen.prompt.slice(0, 80) || "Generated image"}
                    />
                    <div className="gen-caption" style={{ marginTop: 12 }}>
                      <span className="gen-meta r-prompt">{slots[0].gen.prompt}</span>
                      <span className="gen-meta r-meta">
                        {slots[0].gen.aspectRatio} · {slots[0].gen.resolution}
                      </span>
                    </div>
                  </div>
                ) : (
                  <>
                    <DenoiseFrame
                      seed={slots[0].key}
                      cols={loaderDims.cols}
                      rows={loaderDims.rows}
                      aspect={loaderAspect}
                      done={!generating}
                      onClean={() => slotCleaned(slots[0].key)}
                    />
                    <div className={generating ? "gen-caption" : "gen-caption fading"}>
                      <span className="gen-status">Generating · {genElapsed}s</span>
                      <span className="gen-meta">
                        {aspect} · {resolution}
                      </span>
                    </div>
                  </>
                )}
              </div>
            ) : filtered.length === 0 && slots.length === 0 ? (
              <div className="empty">
                <img className="hero-logo" src={logoUrl} alt="" aria-hidden="true" />
                <h3>
                  {generations.length === 0 ? (
                    <>Your <span className="accent">lamp</span> is ready</>
                  ) : (
                    "Nothing matches"
                  )}
                </h3>
                <p>
                  {generations.length === 0
                    ? "Write a prompt, pick a shape and press Generate. Your image appears here."
                    : "Try a different search or shape filter."}
                </p>
              </div>
            ) : (
              <div className="grid">
                {slotCards}
                {filtered.map((g) => (
                  <GenCard
                    key={g.id}
                    g={g}
                    onOpen={setLightbox}
                    onRetry={retryGen}
                    onCopy={(url) => void copyImage(url)}
                    onDownload={(gen) =>
                      downloadDataUrl(gen.imageUrl, `imaginegenie-${gen.id.slice(0, 8)}.png`)
                    }
                    onDelete={setPendingDelete}
                  />
                ))}
              </div>
            )}
          </section>

          <footer className="footer">
            <LockIcon size={14} />
            <span>
              Images are encrypted with <code>{alg}</code> in IndexedDB, stay in this browser
              and are never written to disk. Totals reset each session.
            </span>
          </footer>
        </main>
      </div>
      )}

      {/* references */}
      {tab === "refs" && (
        <div className="shell">
        <main className="main-col">
          <h2 className="visually-hidden">References</h2>
          <ReferencesTab
            onUseReference={useReference}
            onViewImage={setViewRef}
            pushToast={pushToast}
            onCountChange={setReferenceCount}
          />
          <footer className="footer">
            <span id="ref-library">
              References encrypted with <code>{alg}</code> in IndexedDB · never written to disk
            </span>
          </footer>
        </main>
        </div>
      )}

      {/* mobile drawer chrome */}
      {tab === "studio" && (
        <>
          <button
            ref={peekRef}
            type="button"
            className={drawerOpen ? "peek-bar peek-hidden" : "peek-bar"}
            aria-hidden={drawerOpen}
            tabIndex={drawerOpen ? -1 : 0}
            onClick={() => setDrawerOpen(true)}
          >
            <SparkIcon size={16} /> New image · tap to expand
          </button>
          {drawerOpen && (
            <div
              className="sheet-backdrop"
              aria-hidden="true"
              onClick={() => setDrawerOpen(false)}
            />
          )}
        </>
      )}

      {/* lightbox */}
      {lightbox && (
        <div className="overlay" onClick={() => setLightbox(null)}>
          <div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Generation details"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              className="full"
              src={lightbox.imageUrl}
              alt={lightbox.prompt.slice(0, 120) || "Generated image"}
            />
            <div className="lb-side">
              <h3>Generation</h3>
              <div className="lb-prompt">{lightbox.prompt}</div>
              <div className="lb-grid">
                <div className="lb-stat">
                  <small>Cost</small>
                  <b>{fmtCost(lightbox.cost)}</b>
                </div>
                <div className="lb-stat">
                  <small>Created</small>
                  <b>{fmtTime(lightbox.createdAt)}</b>
                </div>
                <div className="lb-stat">
                  <small>Aspect</small>
                  <b>{lightbox.aspectRatio}</b>
                </div>
                <div className="lb-stat">
                  <small>Resolution</small>
                  <b>{lightbox.resolution}</b>
                </div>
                <div className="lb-stat">
                  <small>Type</small>
                  <b>{lightbox.mediaType}</b>
                </div>
                <div className="lb-stat">
                  <small>References</small>
                  <b>{lightbox.refCount}</b>
                </div>
              </div>
              <div className="lb-refs">
                <div className="field-label">
                  <span>References</span>
                  <span className="count">
                    {lightbox.refUrls.length} · ~{refsKb(lightbox.refUrls)} KB stored
                  </span>
                </div>
                {lightbox.refUrls.length === 0 ? (
                  <div className="lb-refs-empty">No reference images were used.</div>
                ) : (
                  <>
                    <div className="ref-strip">
                      {lightbox.refUrls.map((u, i) => (
                        <div className="ref-cell" key={`lbref-${u.length}-${u.slice(22, 46)}`}>
                          <button
                            type="button"
                            className="ref-cell-img"
                            title="View full size"
                            aria-label={`View reference ${i + 1} full size`}
                            onClick={() => setViewRef(u)}
                          >
                            <img src={u} alt={`Reference ${i + 1}`} loading="lazy" />
                          </button>
                          <span className="ref-cell-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="Copy reference image"
                              aria-label={`Copy reference ${i + 1}`}
                              onClick={() => void copyImage(u)}
                            >
                              <CopyIcon size={13} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="View full size"
                              aria-label={`View reference ${i + 1} full size`}
                              onClick={() => setViewRef(u)}
                            >
                              <EyeIcon size={13} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Load into composer"
                              aria-label={`Load reference ${i + 1} into composer`}
                              onClick={() => reuseRefs([u])}
                            >
                              <UploadIcon size={13} />
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="lb-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => reuseRefs(lightbox.refUrls)}
                      >
                        <UploadIcon size={14} /> Reuse all
                      </button>
                    </div>
                  </>
                )}
              </div>
              <div className="lb-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(lightbox.prompt)
                      .then(() => pushToast("ok", "Prompt copied."))
                      .catch(() => pushToast("err", "Copy failed."));
                  }}
                >
                  <CopyIcon size={14} /> Copy prompt
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void copyImage(lightbox.imageUrl)}
                >
                  <CopyIcon size={14} /> Copy image
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() =>
                    downloadDataUrl(lightbox.imageUrl, `imaginegenie-${lightbox.id.slice(0, 8)}.png`)
                  }
                >
                  <DownloadIcon size={14} /> PNG
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => retryGen(lightbox)}
                >
                  <HistoryIcon size={14} /> Retry
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => setPendingDelete(lightbox)}
                >
                  <DeleteIcon size={14} /> Delete
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => setLightbox(null)}
                >
                  <CloseIcon size={14} /> Close
                </button>
              </div>
              <div className="price-hint">
                b64 payload {Math.round(dataUrlToB64(lightbox.imageUrl).length / 1024)} KB · id{" "}
                {lightbox.id.slice(0, 8)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* reference full view */}
      {viewRef && (
        <div className="overlay overlay-top" onClick={() => setViewRef(null)}>
          <div
            className="ref-view"
            role="dialog"
            aria-modal="true"
            aria-label="Reference image"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={viewRef} alt="Reference full size" />
            <div className="ref-view-bar">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => void copyImage(viewRef)}
              >
                <CopyIcon size={14} /> Copy image
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => reuseRefs([viewRef])}
              >
                <UploadIcon size={14} /> Load into composer
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => setViewRef(null)}
              >
                <CloseIcon size={14} /> Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* delete confirmation */}
      {pendingDelete && (
        <div className="overlay overlay-top" onClick={() => setPendingDelete(null)}>
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="del-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="del-title">Delete this image?</h3>
            <p>This removes it from the encrypted library.</p>
            <div className="confirm-actions">
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-small"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => {
                  const id = pendingDelete.id;
                  setPendingDelete(null);
                  void delGen(id);
                }}
              >
                <DeleteIcon size={14} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* clear-all double confirmation */}
      {clearStep > 0 && (
        <div className="overlay overlay-top" onClick={abortClear}>
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={clearStep === 1 ? "clear-title-1" : "clear-title-2"}
            onClick={(e) => e.stopPropagation()}
          >
            {clearStep === 1 ? (
              <>
                <h3 id="clear-title-1">Delete all {generations.length} images?</h3>
                <p>This removes everything from the encrypted library.</p>
                <div className="confirm-actions">
                  <button
                    ref={clearCancelRef}
                    type="button"
                    className="btn btn-small"
                    onClick={abortClear}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    onClick={() => {
                      setClearText("");
                      setClearStep(2);
                    }}
                  >
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="clear-title-2">Are you absolutely sure?</h3>
                <p>
                  This cannot be undone. All {generations.length} images will be
                  permanently deleted. Type <code>DELETE</code> to confirm.
                </p>
                <input
                  ref={clearInputRef}
                  type="text"
                  className="confirm-input"
                  aria-label="Type DELETE to confirm"
                  placeholder="DELETE"
                  autoComplete="off"
                  spellCheck={false}
                  value={clearText}
                  onChange={(e) => setClearText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && clearText.trim() === "DELETE") {
                      setClearStep(0);
                      setClearText("");
                      void clearAll();
                    }
                  }}
                />
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={abortClear}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={clearText.trim() !== "DELETE"}
                    onClick={() => {
                      setClearStep(0);
                      setClearText("");
                      void clearAll();
                    }}
                  >
                    <DeleteIcon size={14} /> Delete all
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* toasts */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "info" ? "" : t.kind}`}>
            <span className="t-ico">
              {t.kind === "ok" ? (
                <CheckIcon size={15} />
              ) : t.kind === "err" ? (
                <AlertIcon size={15} />
              ) : (
                <SparkIcon size={15} />
              )}
            </span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
