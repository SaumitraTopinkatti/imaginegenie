import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import MaskEditor, { type MaskEditorHandle } from "./MaskEditor";
import SourcePicker from "./SourcePicker";
import DenoiseFrame from "./DenoiseFrame";
import type { Generation, InpaintSource } from "../lib/types";
import { generateImage, type Resolution } from "../lib/openrouter";
import { MODELS } from "../lib/models";
import { b64ToDataUrl, copyImageDataUrl, downloadDataUrl, fileToDataUrl, isAccepted } from "../lib/images";
import { saveGeneration } from "../lib/library";
import { inpaintSrcParam } from "../lib/route";
import { replaceUrl } from "../lib/historyLayers";
import {
  MAX_INSTRUCTION,
  buildInpaintPrompt,
  compositeInpaint,
  inpaintCost,
  nearestAspect,
} from "../lib/inpaint";
import { BrushIcon, CloseIcon, CopyIcon, DownloadIcon, GalleryIcon, UploadIcon } from "./icons";
import { SHEET_MQ, useBottomSheet } from "../lib/useBottomSheet";

export interface InpaintTabProps {
  hidden: boolean;
  generations: Generation[];
  resolveKey: () => Promise<string>;
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
  degraded: string;
  onSaved: (gen: Generation) => void;
  onOpenInStudio: (gen: Generation) => void;
  pendingSource: InpaintSource | null;
  onConsumeSource: () => void;
  /** Reports source switches so App keeps the deep-link URL in sync (D18). */
  onSourceChange: (src: { kind: string; id?: string } | null) => void;
}

/**
 * Inpaint section (N6): pick → paint → instruct → generate → result.
 * One image per run (D13), own locks concurrent with Studio. Never uses the
 * `.composer` class (that drags in sticky/sheet CSS + the global Ctrl+Enter);
 * the panel below owns a scoped Ctrl+Enter instead.
 */

function fmtCost(n: number): string {
  if (!isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

interface InpaintResult {
  gen: Generation;
  beforeUrl: string;
}

/** Optional user reference (upload or library), sent after the base images. */
interface ExtraRef {
  id: string;
  url: string;
}

export default function InpaintTab({
  hidden,
  generations,
  resolveKey,
  pushToast,
  degraded,
  onSaved,
  onOpenInStudio,
  pendingSource,
  onConsumeSource,
  onSourceChange,
}: InpaintTabProps) {
  const [source, setSource] = useState<InpaintSource | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  /** Extra references: kept across tab switches; cleared only by their remove buttons. */
  const [extraRefs, setExtraRefs] = useState<ExtraRef[]>([]);
  const [extraDragOver, setExtraDragOver] = useState(false);
  const extraSeq = useRef(0);
  const extraFileInput = useRef<HTMLInputElement>(null);
  const [instruction, setInstruction] = useState("");
  const [resolution, setResolution] = useState<Resolution>("1K");
  const [includeOriginal, setIncludeOriginal] = useState(true);
  // Seedream ref cap: base images (2 with the knob on, else 1) + extras <= maxRefs.
  const maxRefs = MODELS.seedream.maxRefs;
  const baseRefCount = includeOriginal ? 2 : 1;
  const extraCap = maxRefs - baseRefCount;
  const [pixelExact, setPixelExact] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [showLoader, setShowLoader] = useState(false);
  const [loaderDone, setLoaderDone] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<InpaintResult | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const [maskOk, setMaskOk] = useState(false);
  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);
  /** Remount nonce: result-reuse clears the mask explicitly (no confirm). */
  const [editorKey, setEditorKey] = useState(0);
  const editorRef = useRef<MaskEditorHandle>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  /** Measured canvas width at run start: the loader keeps this exact box. */
  const [loaderW, setLoaderW] = useState<number | null>(null);
  // Mobile bottom sheet for the controls (same pattern as Studio's drawer).
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const { grabProps } = useBottomSheet({
    open: sheetOpen,
    setOpen: setSheetOpen,
    sheetRef,
    peekRef,
    initialFocusSelector: "textarea",
  });
  const lockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Entry points (lightbox / viewer / deep link): adopt once, then release.
  useEffect(() => {
    if (!pendingSource) return;
    setSource(pendingSource);
    setResult(null);
    setShowBefore(false);
    onConsumeSource();
  }, [pendingSource, onConsumeSource]);

  // Deep-link URL (D18): the active tab owns ?src= via replaceState; App
  // restores it on goTo("inpaint"). Strokes are never persisted.
  const sourceChangeRef = useRef(onSourceChange);
  sourceChangeRef.current = onSourceChange;
  useEffect(() => {
    sourceChangeRef.current(source ? { kind: source.kind, id: source.id } : null);
    if (hidden || !source) return;
    const want = `/inpaint${inpaintSrcParam(source)}`;
    const cur = window.location.pathname + window.location.search;
    if (cur !== want) replaceUrl(want);
  }, [source, hidden]);

  // Going hidden (tab switch, back/forward) closes the picker and any open
  // discard confirm — portals survive the section hiding otherwise.
  const [dialogReset, setDialogReset] = useState(0);
  useEffect(() => {
    if (!hidden) return;
    setPickerOpen(false);
    setRefPickerOpen(false);
    setSheetOpen(false);
    setDialogReset((k) => k + 1);
  }, [hidden]);
  // Live sheet state for doInpaint (a useCallback would see a stale value).
  const sheetOpenRef = useRef(sheetOpen);
  sheetOpenRef.current = sheetOpen;

  // Source dimensions for the aspect notice + loader frame (ratio only;
  // the working grid preserves the source ratio).
  useEffect(() => {
    if (!source) {
      setSourceDims(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.src = source.url;
    img
      .decode()
      .then(() => {
        if (!cancelled) setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
      })
      .catch(() => {
        if (!cancelled) setSourceDims(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Elapsed clock + tab-close warning while a paid result may be unsaved.
  useEffect(() => {
    if (!generating) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBefore);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("beforeunload", onBefore);
    };
  }, [generating]);

  const addExtra = (urls: string[]) =>
    setExtraRefs((cur) =>
      [...cur, ...urls.map((url) => ({ id: `x${Date.now().toString(36)}-${extraSeq.current++}`, url }))].slice(
        0,
        extraCap
      )
    );
  const removeExtra = (id: string) => setExtraRefs((cur) => cur.filter((r) => r.id !== id));

  const addExtraFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (list.length > extraCap - extraRefs.length) {
      pushToast("err", `Limit is ${extraCap} extra references (${maxRefs} total). Remove some first.`);
      return;
    }
    if (list.some((f) => !isAccepted(f))) {
      pushToast("err", "Only PNG, JPG or WebP files.");
      return;
    }
    try {
      addExtra(await Promise.all(list.map((f) => fileToDataUrl(f))));
    } catch (e) {
      pushToast("err", e instanceof Error ? e.message : "Could not read images.");
    }
  };

  const doInpaint = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    try {
      if (generating) return;
      if (!source) {
        setError("Choose an image first.");
        return;
      }
      if (!maskOk) {
        setError("Paint the area to change first.");
        return;
      }
      const trimmed = instruction.trim();
      if (!trimmed) {
        setError("Describe the change first.");
        return;
      }
      // Toggling the knob on can push extras over the cap: block before any POST.
      if (extraRefs.length > extraCap) {
        setError(
          `Seedream takes up to ${maxRefs} references in total — remove ${extraRefs.length - extraCap}. No request was sent.`
        );
        return;
      }
      const key = await resolveKey();
      if (!key) {
        setError("Add your OpenRouter API key first (key button in the header).");
        return;
      }
      // Degraded crypto: block BEFORE any POST — paid pixels that can't be
      // saved must never be requested.
      if (degraded !== "") {
        setError("Encryption unavailable — generation is disabled. No request was sent.");
        return;
      }
      const editor = editorRef.current;
      if (!editor) {
        setError("The editor is not ready yet.");
        return;
      }
      setError("");
      // Pin the loader to the live canvas box (N20): small sources display
      // small, so the 70dvh cap alone would still jump the layout.
      const wrapW =
        editorHostRef.current
          ?.querySelector(".mask-canvas-wrap")
          ?.getBoundingClientRect().width ?? 0;
      setLoaderW(wrapW > 0 ? Math.round(wrapW) : null);
      setGenerating(true);
      setShowLoader(true);
      setLoaderDone(false);
      setResult(null);
      setShowBefore(false);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const { original, marked, width, height } = await editor.exportImages();
        const extraUrls = extraRefs.map((r) => r.url);
        const prompt = buildInpaintPrompt({ instruction: trimmed, includeOriginal, extraRefs: extraUrls.length });
        const refs = [...(includeOriginal ? [original, marked] : [marked]), ...extraUrls];
        const aspect = nearestAspect(width, height).ratio;
        const res = await generateImage(
          key,
          { prompt, aspect_ratio: aspect, resolution, refs, model: MODELS.seedream.requestId },
          ctrl.signal
        );
        const outputUrl = b64ToDataUrl(res.b64, res.mediaType);
        let finalUrl = outputUrl;
        let mediaType = res.mediaType;
        let composited = false;
        if (pixelExact) {
          try {
            finalUrl = await compositeInpaint(original, outputUrl, editor.getMaskCanvas());
            mediaType = "image/jpeg";
            composited = true;
          } catch {
            // Composite is a guarantee, not a gamble: a failure here must
            // not silently save drifted pixels as "exact".
            throw new Error("Could not preserve the unpainted area — nothing saved. Try again.");
          }
        }
        try {
          const gen = await saveGeneration({
            imageUrl: finalUrl,
            prompt,
            aspectRatio: aspect,
            resolution,
            cost: res.cost,
            mediaType,
            refUrls: refs,
            model: MODELS.seedream.requestId,
            inpaint: {
              instruction: trimmed.slice(0, MAX_INSTRUCTION),
              source: source.kind,
              sourceId: source.id,
              includedOriginal: includeOriginal,
              composited,
              extraRefs: extraUrls.length,
            },
          });
          onSaved(gen);
          setResult({ gen, beforeUrl: original });
          pushToast("ok", `Inpaint ready — ${fmtCost(res.cost)}.`);
          // Mobile sheet closes on success, same as Studio's drawer.
          if (window.matchMedia(SHEET_MQ).matches) setSheetOpen(false);
        } catch {
          setError("The image was generated but could not be saved. It is lost — try again.");
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setError("Cancelled.");
        } else {
          const msg = e instanceof Error ? e.message : "Generation failed.";
          setError(msg);
          // The error box sits inside the sheet: if it is closed on mobile
          // the user would never see it, so toast the same text instead.
          if (window.matchMedia(SHEET_MQ).matches && !sheetOpenRef.current) {
            pushToast("err", msg);
          }
        }
      } finally {
        abortRef.current = null;
        setGenerating(false);
        setLoaderDone(true);
      }
    } finally {
      lockRef.current = false;
    }
  }, [generating, source, maskOk, instruction, resolveKey, degraded, includeOriginal, extraRefs, pixelExact, resolution, onSaved, pushToast]);

  const cancel = () => abortRef.current?.abort();

  const onPanelKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doInpaint();
    }
  };

  const aspectInfo = sourceDims ? nearestAspect(sourceDims.w, sourceDims.h) : null;
  const est = inpaintCost(resolution, baseRefCount + extraRefs.length);
  const refsLabel =
    extraRefs.length === 0
      ? baseRefCount === 2
        ? "2 refs"
        : "1 ref"
      : `${baseRefCount} + ${extraRefs.length} refs`;
  const promptPreview =
    instruction.trim() !== ""
      ? buildInpaintPrompt({ instruction: instruction.trim(), includeOriginal, extraRefs: extraRefs.length })
      : "";
  const loaderAspect =
    sourceDims && sourceDims.h > 0 ? `${sourceDims.w} / ${sourceDims.h}` : "1 / 1";
  const loaderLong = 16;
  const loaderDims =
    sourceDims && sourceDims.w >= sourceDims.h
      ? { cols: loaderLong, rows: Math.max(4, Math.round((loaderLong * sourceDims.h) / sourceDims.w)) }
      : {
          cols: Math.max(4, Math.round((loaderLong * (sourceDims?.w ?? 1)) / (sourceDims?.h ?? 1))),
          rows: loaderLong,
        };

  const reuseResult = () => {
    if (!result) return;
    // Explicit iterate path: remount the editor so the mask clears without
    // the discard confirm (that confirm is for picker/entry switches).
    setSource({ url: result.gen.imageUrl, kind: "image", label: "Inpaint result" });
    setEditorKey((k) => k + 1);
    setResult(null);
    setShowBefore(false);
  };

  const copyResult = () => {
    if (!result) return;
    void copyImageDataUrl(result.gen.imageUrl)
      .then(() => pushToast("ok", "Image copied."))
      .catch(() => pushToast("err", "Copy failed in this browser."));
  };

  return (
    <div className="shell">
      <main className="main-col">
        <section id="inpaint-main" tabIndex={-1} aria-label="Inpaint" hidden={hidden}>
          <div className="inpaint-layout">
            <div
              ref={sheetRef}
              className={"panel inpaint-controls inpaint-sheet" + (sheetOpen ? " open" : "")}
              onKeyDown={onPanelKey}
            >
              {/* Same sheet anatomy as Studio's composer: the dialog semantics
                  live on this neutral wrapper so the panel never remounts. */}
              <div
                className="sheet-dialog"
                {...(sheetOpen
                  ? { role: "dialog", "aria-modal": true, "aria-label": "Inpaint controls" }
                  : {})}
              >
              <div className="sheet-grab" {...grabProps}>
                <span className="grab-handle" aria-hidden="true" />
                <span className="grab-row">
                  <span className="grab-label">
                    <BrushIcon size={15} /> Inpaint
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Close panel"
                    onClick={() => setSheetOpen(false)}
                  >
                    <CloseIcon size={15} />
                  </button>
                </span>
              </div>
              <div className="inpaint-controls-body">
              <h2 className="panel-title">
                Inpaint <span className="title-serif">edits</span>
              </h2>
              <p className="panel-desc">
                Paint what to change in red, describe it, generate. Everything outside the
                paint stays as it is.
              </p>
              <div className="field">
                <div className="field-label">
                  <span>Source image</span>
                </div>
                {source ? (
                  <div className="inpaint-source-row">
                    <img src={source.url} alt="" className="inpaint-source-thumb" aria-hidden="true" />
                    <span className="inpaint-source-label" title={source.label}>
                      {source.label}
                    </span>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={`Change image, currently: ${source.label}`}
                      onClick={() => setPickerOpen(true)}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPickerOpen(true)}
                  >
                    <BrushIcon size={15} /> Choose image
                  </button>
                )}
              </div>
              <div className="field" role="group" aria-labelledby="inpaint-refs-label">
                <div className="field-label">
                  <span id="inpaint-refs-label">Reference images (optional)</span>
                  <span className="count">
                    {extraRefs.length > extraCap
                      ? `${extraRefs.length} / ${extraCap} · remove ${extraRefs.length - extraCap}`
                      : `${extraRefs.length} / ${extraCap}`}
                  </span>
                </div>
                <button
                  type="button"
                  className={extraDragOver ? "dropzone over" : "dropzone"}
                  onClick={() => extraFileInput.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setExtraDragOver(true);
                  }}
                  onDragLeave={() => setExtraDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setExtraDragOver(false);
                    void addExtraFiles(e.dataTransfer.files);
                  }}
                >
                  <span className="dz-ico" aria-hidden="true">
                    <UploadIcon size={16} />
                  </span>
                  <span>
                    <span className="dz-title">Drop or browse images</span>
                    <span className="dz-sub">PNG, JPG or WebP · resized to 2048px max</span>
                  </span>
                </button>
                <input
                  ref={extraFileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addExtraFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <div>
                  <button
                    type="button"
                    className="lib-link"
                    disabled={extraRefs.length >= extraCap}
                    onClick={() => setRefPickerOpen(true)}
                  >
                    <GalleryIcon size={14} /> From library
                  </button>
                </div>
                {extraRefs.length > 0 && (
                  <div className="ref-grid">
                    {extraRefs.map((r, i) => (
                      <div className="ref-thumb" key={r.id}>
                        <img src={r.url} alt={`Reference ${i + 1}`} />
                        <span className="idx">#{i + 1}</span>
                        <button
                          type="button"
                          className="rm"
                          title="Remove"
                          aria-label={`Remove reference ${i + 1}`}
                          onClick={() => removeExtra(r.id)}
                        >
                          <CloseIcon size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="field">
                <div className="field-label">
                  <span>
                    Instruction <span aria-hidden="true">· Ctrl+Enter to generate</span>
                  </span>
                  <span className="count">
                    {instruction.length}/{MAX_INSTRUCTION}
                  </span>
                </div>
                <textarea
                  className="prompt"
                  aria-label="Inpaint instruction"
                  aria-required="true"
                  aria-describedby={error ? "inpaint-error" : undefined}
                  placeholder="Replace this with a shiny basketball"
                  value={instruction}
                  maxLength={MAX_INSTRUCTION}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </div>
              <div className="field">
                <div className="field-label">
                  <span id="inpaint-res-label">Resolution</span>
                </div>
                <div className="seg" role="group" aria-labelledby="inpaint-res-label">
                  <button
                    type="button"
                    className={resolution === "1K" ? "active" : ""}
                    aria-pressed={resolution === "1K"}
                    onClick={() => setResolution("1K")}
                  >
                    1K <small>${MODELS.seedream.price["1K"].toFixed(3)} / image</small>
                  </button>
                  <button
                    type="button"
                    className={resolution === "2K" ? "active" : ""}
                    aria-pressed={resolution === "2K"}
                    onClick={() => setResolution("2K")}
                  >
                    2K <small>${MODELS.seedream.price["2K"].toFixed(2)} / image</small>
                  </button>
                </div>
                {aspectInfo && aspectInfo.error > 0.03 && (
                  <div className="inpaint-aspect-note">
                    Closest shape is {aspectInfo.ratio} — edges may shift slightly.
                  </div>
                )}
              </div>
              <details className="inpaint-advanced">
                <summary>Advanced</summary>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={includeOriginal}
                    onChange={(e) => setIncludeOriginal(e.target.checked)}
                  />
                  <span>
                    Send original as reference
                    <small>
                      On: the model sees the clean image plus the red-marked copy (2 base refs).
                      Off: marked copy only (1 base ref) — cheaper, but red already in the scene
                      (red car, sunset) turns ambiguous without the clean image.
                    </small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={pixelExact}
                    onChange={(e) => setPixelExact(e.target.checked)}
                  />
                  <span>
                    Keep unpainted area pixel-exact
                    <small>
                      Blends the model output back into your image through the painted mask,
                      so outside stays bit-identical.
                    </small>
                  </span>
                </label>
                {promptPreview !== "" && (
                  <div className="field">
                    <div className="field-label">
                      <span>Prompt sent</span>
                    </div>
                    <div className="inpaint-preview">{promptPreview}</div>
                  </div>
                )}
              </details>
              {error !== "" && (
                <div className="error-box" role="alert" id="inpaint-error">
                  {error}
                </div>
              )}
              <div className="gen-foot inpaint-foot">
                {generating ? (
                  <button type="button" className="btn" onClick={cancel}>
                    Cancel · {elapsed}s
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn gen-btn"
                    disabled={degraded !== ""}
                    title={degraded !== "" ? "Disabled: encryption unavailable" : undefined}
                    onClick={() => void doInpaint()}
                  >
                    Generate · {fmtCost(est)}
                  </button>
                )}
              </div>
              </div>
              </div>
            </div>
            <div className="inpaint-editor">
              {!source ? (
                <div className="panel inpaint-empty">
                  <GalleryIcon size={28} />
                  <p>No image yet. Choose one from Generations or References to start painting.</p>
                  <button type="button" className="btn btn-small" onClick={() => setPickerOpen(true)}>
                    Choose image
                  </button>
                </div>
              ) : (
                <>
                  <div hidden={showLoader} ref={editorHostRef}>
                    <MaskEditor
                      key={editorKey}
                      ref={editorRef}
                      sourceUrl={source.url}
                      sourceLabel={source.label}
                      dismissDialogsSignal={dialogReset}
                      onMaskChange={(ok) => setMaskOk(ok)}
                    />
                  </div>
                  {showLoader && (
                    <div
                      className="inpaint-loader"
                      style={
                        {
                          "--loader-ar":
                            sourceDims && sourceDims.h > 0
                              ? sourceDims.w / sourceDims.h
                              : 1,
                          "--loader-w": loaderW != null ? `${loaderW}px` : undefined,
                        } as CSSProperties
                      }
                    >
                      <DenoiseFrame
                        seed={7}
                        cols={loaderDims.cols}
                        rows={loaderDims.rows}
                        aspect={loaderAspect}
                        done={loaderDone}
                        onClean={() => setShowLoader(false)}
                      />
                      <div className="gen-caption">
                        <span className="gen-status">Generating · {elapsed}s</span>
                        <span className="gen-meta">
                          {resolution} · {refsLabel}
                        </span>
                      </div>
                    </div>
                  )}
                  {result && !showLoader && (
                    <div className="panel inpaint-result">
                      <div className="seg" role="group" aria-label="Result view">
                        <button
                          type="button"
                          className={!showBefore ? "active" : ""}
                          aria-pressed={!showBefore}
                          onClick={() => setShowBefore(false)}
                        >
                          After
                        </button>
                        <button
                          type="button"
                          className={showBefore ? "active" : ""}
                          aria-pressed={showBefore}
                          onClick={() => setShowBefore(true)}
                        >
                          Before
                        </button>
                      </div>
                      <img
                        className="inpaint-result-img"
                        src={showBefore ? result.beforeUrl : result.gen.imageUrl}
                        alt={showBefore ? "Original source before inpainting" : "Inpainted result"}
                      />
                      <div className="lb-actions">
                        <button type="button" className="btn btn-small" onClick={reuseResult}>
                          <BrushIcon size={14} /> Use as new source
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() =>
                            downloadDataUrl(result.gen.imageUrl, `imaginegenie-${result.gen.id.slice(0, 8)}.png`)
                          }
                        >
                          <DownloadIcon size={14} /> PNG
                        </button>
                        <button type="button" className="btn btn-small" onClick={copyResult}>
                          <CopyIcon size={14} /> Copy
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-ghost"
                          onClick={() => onOpenInStudio(result.gen)}
                        >
                          Open in Studio
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          {/* mobile sheet chrome (inside the section so [hidden] removes it) */}
          <button
            ref={peekRef}
            type="button"
            className={sheetOpen ? "peek-bar peek-hidden" : "peek-bar"}
            aria-hidden={sheetOpen}
            tabIndex={sheetOpen ? -1 : 0}
            onClick={() => setSheetOpen(true)}
          >
            <BrushIcon size={16} />{" "}
            {generating ? `Generating · ${elapsed}s · tap to expand` : "Describe the edit · tap to expand"}
          </button>
          {sheetOpen && (
            <div
              className="sheet-backdrop"
              aria-hidden="true"
              onClick={() => setSheetOpen(false)}
            />
          )}
        </section>
      </main>
      {refPickerOpen && (
        <SourcePicker
          generations={generations}
          pushToast={pushToast}
          onPick={() => undefined}
          onClose={() => setRefPickerOpen(false)}
          multi={{
            max: extraCap - extraRefs.length,
            onPickMany: (urls) => {
              setRefPickerOpen(false);
              addExtra(urls);
            },
          }}
        />
      )}
      {pickerOpen && (
        <SourcePicker
          generations={generations}
          pushToast={pushToast}
          onPick={(s) => {
            setPickerOpen(false);
            setSource(s);
            setResult(null);
            setShowBefore(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

