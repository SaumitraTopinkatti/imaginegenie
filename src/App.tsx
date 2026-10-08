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
  dataUrlToB64,
  downloadDataUrl,
  fileToDataUrl,
  isAccepted,
  makeThumb,
} from "./lib/images";
import {
  clearRecords,
  cryptoMode,
  decryptRecord,
  deleteRecord,
  encryptText,
  exportBackup,
  importBackup,
  initCrypto,
  listRawRecords,
  saveRecord,
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
  HistoryIcon,
  KeyIcon,
  LockIcon,
  SearchIcon,
  SparkIcon,
  UploadIcon,
} from "./components/icons";
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
const PRICE_1K = 0.045;
const PRICE_2K = 0.09;
const KEY_SESSION = "imaginegenie.key";
const TOTALS_KEY = "imaginegenie.totals.v1";

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
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const progressTimer = useRef<number | null>(null);

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
  const [viewRef, setViewRef] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const clearCancelRef = useRef<HTMLButtonElement>(null);
  const clearInputRef = useRef<HTMLInputElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const touchY = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const importInput = useRef<HTMLInputElement>(null);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  /* ----- totals (non-sensitive, localStorage) ----- */
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

  useEffect(() => {
    try {
      localStorage.setItem(
        TOTALS_KEY,
        JSON.stringify({ images: totals.images, spend: totals.spend, refs: totals.refs })
      );
    } catch {
      /* noop */
    }
  }, [totals]);

  /* ----- boot: key env note + decrypt library ----- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mode = await initCrypto();
      if (cancelled) return;
      setAlg(mode === "AES-GCM-256" ? "AES-GCM-256" : cryptoMode());
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
        if (!cancelled) setGenerations(out);
      } catch {
        if (!cancelled) pushToast("err", "Could not open encrypted library.");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushToast]);

  useEffect(() => {
    try {
      if (apiKey) sessionStorage.setItem(KEY_SESSION, apiKey);
      else sessionStorage.removeItem(KEY_SESSION);
    } catch {
      /* noop */
    }
  }, [apiKey]);

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
    if (generating) return;
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
    setGenerating(true);
    setProgress(6);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = window.setInterval(() => {
      setProgress((p) => (p >= 92 ? p : p + Math.max(1, (92 - p) / 14)));
    }, 350);
    try {
      const res = await generateImage(
        key,
        { prompt: prompt.trim(), aspect_ratio: aspect, resolution, refs, seed },
        ctrl.signal
      );
      setProgress(96);
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
      setGenerations((g) => [gen, ...g]);
      setProgress(100);
      pushToast("ok", `Image ready — ${fmtCost(res.cost)} this call.`);
      if (window.matchMedia("(max-width: 900px)").matches) setDrawerOpen(false);
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
  }, [generating, apiKey, prompt, aspect, resolution, refs, seedStr, pushToast]);

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

  /* ----- library ops ----- */
  const delGen = async (id: string) => {
    setGenerations((g) => g.filter((x) => x.id !== id));
    if (lightbox?.id === id) setLightbox(null);
    try {
      await deleteRecord(id);
    } catch {
      pushToast("err", "Delete failed in storage.");
    }
  };

  const abortClear = () => {
    setClearStep(0);
    setClearText("");
  };

  const clearAll = async () => {
    if (generations.length === 0) return;
    setGenerations([]);
    setLightbox(null);
    try {
      await clearRecords();
      pushToast("ok", "Library cleared.");
    } catch {
      pushToast("err", "Clear failed in storage.");
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
    try {
      const text = await f.text();
      const n = await importBackup(text);
      pushToast("ok", `Imported ${n} record(s). Reloading…`);
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
          /* skip */
        }
      }
      setGenerations(out);
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

  const filtered = useMemo(() => {    const q = search.trim().toLowerCase();
    return generations.filter((g) => {
      if (aspectFilter !== "all" && g.aspectRatio !== aspectFilter) return false;
      if (q && !g.prompt.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [generations, search, aspectFilter]);

  const estPrice = resolution === "2K" ? PRICE_2K : PRICE_1K;

  return (
    <div>
      {/* header */}
      <header className="header">
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
                Imagine<em>Genie</em>
              </div>
              <div className="brand-sub">AI image studio · single user</div>
            </div>
          </div>
          <span className="model-badge">
            <span className="dot" />
            Seedream 5.0 Pro
          </span>
          <div className="header-spacer" />
          <span className="lock-note">
            <LockIcon size={13} /> Encrypted library · stays in this browser
          </span>
          <div className="session-pill" title="This library totals">
            <div className="stat">
              <b>{totals.images}</b>
              <span>Images</span>
            </div>
            <div className="stat">
              <b>{fmtCost(totals.spend)}</b>
              <span>Session spend</span>
            </div>
          </div>
        </div>
      </header>

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
            <h2 className="panel-title">
              <SparkIcon size={16} /> New image
            </h2>
            <p className="panel-desc">
              {MODEL} · n = 1 · references cost a little extra.
            </p>

            <div className="field">
              <div className="field-label">
                <span>Prompt</span>
                <span className="count">
                  {prompt.length}/{MAX_PROMPT}
                </span>
              </div>
              <textarea
                className="prompt"
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
                <span>Aspect ratio</span>
              </div>
              <div className="aspect-grid">
                {ASPECT_RATIOS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={aspect === a ? "chip active" : "chip"}
                    onClick={() => setAspect(a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Resolution</span>
              </div>
              <div className="seg">
                <button
                  type="button"
                  className={resolution === "1K" ? "active" : ""}
                  onClick={() => setResolution("1K")}
                >
                  1K<small>$0.045 / image</small>
                </button>
                <button
                  type="button"
                  className={resolution === "2K" ? "active" : ""}
                  onClick={() => setResolution("2K")}
                >
                  2K<small>$0.09 / image</small>
                </button>
              </div>
              <div className="price-hint">
                Estimate: <b>{fmtCost(estPrice + refs.length * 0.003)}</b> with {refs.length}{" "}
                ref(s)
              </div>
            </div>

            <div className="row2">
              <div className="field">
                <div className="field-label">
                  <span>Seed (optional)</span>
                </div>
                <div className="seed-row">
                  <input
                    type="number"
                    min={0}
                    step={1}
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
              <div className="field">
                <div className="field-label">
                  <span>Count</span>
                </div>
                <input type="number" value={1} disabled title="Fixed at 1 by provider" />
              </div>
            </div>

            <div className="field">
              <div className="field-label">
                <span>Reference images</span>
                <span className="count">
                  {refs.length}/{MAX_REFS}
                </span>
              </div>
              <div
                className={dragOver ? "dropzone over" : "dropzone"}
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") fileInput.current?.click();
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
                <div className="dz-title">Drop images here or click to browse</div>
                <div className="dz-sub">PNG · JPG · WebP — resized to max 2048px in browser</div>
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
                  type={showKey ? "text" : "password"}
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

            <button
              type="button"
              className="gen-btn"
              disabled={generating}
              onClick={() => void doGenerate()}
            >
              {generating ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Conjuring…{" "}
                  {Math.round(progress)}%
                </>
              ) : (
                <>
                  <SparkIcon size={18} /> Generate — {fmtCost(estPrice + refs.length * 0.003)}
                </>
              )}
            </button>
            {generating && (
              <>
                <div className="progress">
                  <i style={{ width: `${progress}%` }} />
                </div>
                <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
                  <button type="button" className="btn btn-small btn-ghost" onClick={cancelGen}>
                    <CloseIcon size={13} /> Cancel
                  </button>
                </div>
              </>
            )}
            {error && <div className="error-box">{error}</div>}
            <div className="kbd-hint">
              <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to generate
            </div>
          </aside>

          <div className="main-col">
            {/* metrics */}
            <section className="metrics" aria-label="Session metrics">
              <div className="metric">
                <small>Images</small>
                <b>{totals.images}</b>
                <span className="hint">in encrypted library</span>
              </div>
              <div className="metric">
                <small>Session spend</small>
                <b>{fmtCost(totals.spend)}</b>
                <span className="hint">sum of usage.cost</span>
              </div>
              <div className="metric">
                <small>Avg / image</small>
                <b>{fmtCost(totals.avg)}</b>
                <span className="hint">spend ÷ images</span>
              </div>
              <div className="metric">
                <small>Input refs used</small>
                <b>{totals.refs}</b>
                <span className="hint">$0.003 per extra image</span>
              </div>
              <div className="metric">
                <small>Price / image</small>
                <b>
                  $0.045 <span className="unit">1K</span>
                </b>
                <span className="hint">$0.09 high-res 2K</span>
              </div>
            </section>

            {/* gallery */}
          <section className="panel gallery" aria-label="Gallery">
            <div className="gallery-bar">
              <div className="search">
                <span className="icon">
                  <SearchIcon size={16} />
                </span>
                <input
                  type="text"
                  placeholder="Search prompts…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                value={aspectFilter}
                onChange={(e) => setAspectFilter(e.target.value)}
                style={{ width: "auto" }}
                title="Filter by aspect"
              >
                <option value="all">All aspects</option>
                {ASPECT_RATIOS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <div className="tool-row">
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => void doExport()}
                >
                  <DownloadIcon size={14} /> Backup
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => importInput.current?.click()}
                >
                  <UploadIcon size={14} /> Restore
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  disabled={generations.length === 0}
                  onClick={() => {
                    setClearText("");
                    setClearStep(1);
                  }}
                >
                  <DeleteIcon size={14} /> Clear
                </button>
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
            ) : generating && generations.length === 0 ? (
              <div className="grid">
                <div className="skel">
                  <div className="ph" />
                  <div className="ln" />
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty">
                <div className="orb-wrap" aria-hidden="true">
                  <span className="star s1">
                    <SparkIcon size={13} />
                  </span>
                  <span className="star s2">
                    <SparkIcon size={11} />
                  </span>
                  <span className="star s3">
                    <SparkIcon size={9} />
                  </span>
                  <span className="star s4">
                    <SparkIcon size={10} />
                  </span>
                  <img className="hero-logo" src={logoUrl} alt="" />
                </div>
                <h3>
                  {generations.length === 0 ? "Your lamp is ready" : "Nothing matches"}
                </h3>
                <p>
                  {generations.length === 0
                    ? "Write a prompt on the left, add up to 14 reference images, then hit Generate. Results stay encrypted in this browser."
                    : "Try a different search or aspect filter."}
                </p>
              </div>
            ) : (
              <div className="grid">
                {generating && (
                  <div className="skel">
                    <div className="ph" />
                    <div className="ln" />
                  </div>
                )}
                {filtered.map((g) => (
                  <article className="card" key={g.id} onClick={() => setLightbox(g)}>
                    <div className="thumb">
                      <img src={g.thumbUrl} alt={g.prompt.slice(0, 80) || "Generated image"} loading="lazy" />
                      <span className="cost-tag">{fmtCost(g.cost)}</span>
                    </div>
                    <div className="body">
                      <div className="prompt-snippet">{g.prompt}</div>
                      <div className="meta">
                        <span className="tag">{g.aspectRatio}</span>
                        <span className="tag">{g.resolution}</span>
                        <span className="tag">{g.mediaType.replace("image/", "")}</span>
                        {g.refCount > 0 && (
                          <span className="tag hl">+{g.refCount} ref</span>
                        )}
                      </div>
                      <div className="foot">
                        <span className="time">{fmtTime(g.createdAt)}</span>
                        <span className="actions">
                          <button
                            type="button"
                            className="icon-btn"
                            title="Retry with same settings"
                            aria-label="Retry with same settings"
                            onClick={(e) => {
                              e.stopPropagation();
                              retryGen(g);
                            }}
                          >
                            <HistoryIcon size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Download PNG"
                            aria-label="Download PNG"
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadDataUrl(g.imageUrl, `imaginegenie-${g.id.slice(0, 8)}.png`);
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
                              setPendingDelete(g);
                            }}
                          >
                            <DeleteIcon size={15} />
                          </button>
                        </span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <footer className="footer">
          <span>
            Images encrypted with <code>{alg}</code> in IndexedDB · never written to disk · totals
            only in localStorage
          </span>
          <span>
            Model <code>{MODEL}</code> · n=1 · data URL refs 0–14
          </span>
          </footer>
        </div>
      </div>

      {/* mobile drawer chrome */}
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

      {/* lightbox */}
      {lightbox && (
        <div className="overlay" onClick={() => setLightbox(null)}>
          <div className="lightbox" onClick={(e) => e.stopPropagation()}>
            <img className="full" src={lightbox.imageUrl} alt={lightbox.prompt} />
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
      <div className="toasts">
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
