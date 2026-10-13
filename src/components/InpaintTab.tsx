import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import MaskEditor, { type MaskEditorHandle } from "./MaskEditor";
import SourcePicker from "./SourcePicker";
import DenoiseFrame from "./DenoiseFrame";
import type { Generation, InpaintSource } from "../lib/types";
import { generateImage, type Resolution } from "../lib/openrouter";
import { b64ToDataUrl, copyImageDataUrl, downloadDataUrl } from "../lib/images";
import { saveGeneration } from "../lib/library";
import { inpaintSrcParam } from "../lib/route";
import {
  MAX_INSTRUCTION,
  buildInpaintPrompt,
  compositeInpaint,
  inpaintCost,
  nearestAspect,
} from "../lib/inpaint";
import { BrushIcon, CopyIcon, DownloadIcon, GalleryIcon } from "./icons";

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
  const [instruction, setInstruction] = useState("");
  const [resolution, setResolution] = useState<Resolution>("1K");
  const [includeOriginal, setIncludeOriginal] = useState(true);
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
    if (cur !== want) window.history.replaceState(null, "", want);
  }, [source, hidden]);

  // Going hidden (tab switch, back/forward) closes the picker and any open
  // discard confirm — portals survive the section hiding otherwise.
  const [dialogReset, setDialogReset] = useState(0);
  useEffect(() => {
    if (!hidden) return;
    setPickerOpen(false);
    setDialogReset((k) => k + 1);
  }, [hidden]);

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
        const prompt = buildInpaintPrompt({ instruction: trimmed, includeOriginal });
        const refs = includeOriginal ? [original, marked] : [marked];
        const aspect = nearestAspect(width, height).ratio;
        const res = await generateImage(
          key,
          { prompt, aspect_ratio: aspect, resolution, refs },
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
            inpaint: {
              instruction: trimmed.slice(0, MAX_INSTRUCTION),
              source: source.kind,
              sourceId: source.id,
              includedOriginal: includeOriginal,
              composited,
            },
          });
          onSaved(gen);
          setResult({ gen, beforeUrl: original });
          pushToast("ok", `Inpaint ready — ${fmtCost(res.cost)}.`);
        } catch {
          setError("The image was generated but could not be saved. It is lost — try again.");
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setError("Cancelled.");
        } else {
          setError(e instanceof Error ? e.message : "Generation failed.");
        }
      } finally {
        abortRef.current = null;
        setGenerating(false);
        setLoaderDone(true);
      }
    } finally {
      lockRef.current = false;
    }
  }, [generating, source, maskOk, instruction, resolveKey, degraded, includeOriginal, pixelExact, resolution, onSaved, pushToast]);

  const cancel = () => abortRef.current?.abort();

  const onPanelKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doInpaint();
    }
  };

  const aspectInfo = sourceDims ? nearestAspect(sourceDims.w, sourceDims.h) : null;
  const est = inpaintCost(resolution, includeOriginal ? 2 : 1);
  const promptPreview =
    instruction.trim() !== ""
      ? buildInpaintPrompt({ instruction: instruction.trim(), includeOriginal })
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
            <div className="panel inpaint-controls" onKeyDown={onPanelKey}>
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
                    1K <small>$0.045 / image</small>
                  </button>
                  <button
                    type="button"
                    className={resolution === "2K" ? "active" : ""}
                    aria-pressed={resolution === "2K"}
                    onClick={() => setResolution("2K")}
                  >
                    2K <small>$0.09 / image</small>
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
                      On: the model sees the clean image plus the red-marked copy (2 refs).
                      Off: marked copy only (1 ref) — cheaper, but red already in the scene
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
                          {resolution} · {includeOriginal ? "2 refs" : "1 ref"}
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
        </section>
      </main>
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

