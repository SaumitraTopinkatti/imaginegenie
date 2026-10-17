import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Dialog from "./Dialog";
import { INPAINT_MAX_DIM, MASK_ALPHA, MASK_COLOR } from "../lib/inpaint";

/**
 * Mask editor (D1/D2/D14). Plain Canvas 2D, no deps.
 *
 * Strokes are vectors (the source of truth) replayed at full opacity onto an
 * offscreen mask canvas; translucency applies only to the display overlay
 * (CSS opacity) and the exported marked copy (globalAlpha). Overlapping
 * strokes therefore stay a uniform tint instead of stacking darker.
 */

export interface MaskEditorHandle {
  hasMask(): boolean;
  exportImages(): Promise<{ original: string; marked: string; width: number; height: number }>;
  /** Opaque-red binary mask at the working grid, for the N7 composite. */
  getMaskCanvas(): HTMLCanvasElement;
}

interface Pt {
  x: number;
  y: number;
}

interface Stroke {
  mode: "paint" | "erase";
  /** Brush diameter in working-grid px (converted from screen px at stroke start). */
  size: number;
  points: Pt[];
}

interface MaskEditorProps {
  /** Source image data URL. A change asks to discard strokes first (Dialog). */
  sourceUrl: string;
  sourceLabel: string;
  onMaskChange?: (hasMask: boolean, coverage: number) => void;
  /** Increment to close the discard confirm (tab switch hides the section
   *  but portals survive — InpaintTab bumps this when going hidden). */
  dismissDialogsSignal?: number;
}

const MIN_BRUSH_SCREEN = 4;
const MAX_BRUSH_SCREEN = 160;

function encodeCanvas(canvas: HTMLCanvasElement): string {
  // Mirror the fileToDataUrl rule: PNG only when small, else JPEG ~0.92.
  const small = canvas.width * canvas.height < 900 * 900;
  return canvas.toDataURL(small ? "image/png" : "image/jpeg", 0.92);
}

const MaskEditor = forwardRef<MaskEditorHandle, MaskEditorProps>(function MaskEditor(
  { sourceUrl, sourceLabel, onMaskChange, dismissDialogsSignal = 0 },
  ref
) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Offscreen working canvases at the source grid (long side ≤ 2048, D3). */
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const liveRef = useRef<Stroke | null>(null);
  const loadedUrlRef = useRef<string>("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [mode, setMode] = useState<"paint" | "erase">("paint");
  const [brushScreen, setBrushScreen] = useState(44);
  const [version, setVersion] = useState(0); // stroke-history generation
  const [coverage, setCoverage] = useState(0);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  // Size preview (N14): shown on every size change, fades ~900ms after last.
  const [previewVisible, setPreviewVisible] = useState(false);
  const previewTimer = useRef<number | null>(null);
  const previewRef = useRef(false);
  previewRef.current = previewVisible;
  const flashPreview = useCallback(() => {
    setPreviewVisible(true);
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      setPreviewVisible(false);
      previewTimer.current = null;
    }, 900);
  }, []);
  useEffect(
    () => () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    },
    []
  );
  // Tab switch while the discard confirm is open: portals survive hiding.
  useEffect(() => {
    if (dismissDialogsSignal > 0) setPendingSource(null);
  }, [dismissDialogsSignal]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const brushRef = useRef(brushScreen);
  brushRef.current = brushScreen;
  const maskChangeRef = useRef(onMaskChange);
  maskChangeRef.current = onMaskChange;

  const notifyMask = useCallback((cov: number) => {
    setCoverage(cov);
    maskChangeRef.current?.(strokesRef.current.length > 0 && cov > 0, cov);
  }, []);

  /** Cheap coverage: sample mask alpha on a 48px-downscaled copy after a stroke ends. */
  const measureCoverage = useCallback((): number => {
    const mask = maskCanvasRef.current;
    if (!mask || strokesRef.current.length === 0) return 0;
    const probe = document.createElement("canvas");
    const s = 48;
    probe.width = s;
    probe.height = Math.max(1, Math.round((s * mask.height) / mask.width));
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    ctx.drawImage(mask, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let hit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) hit += 1;
    return hit / (data.length / 4);
  }, []);

  const paintStrokeOn = useCallback(
    (ctx: CanvasRenderingContext2D, s: Stroke, fromIndex: number) => {
      ctx.save();
      ctx.globalCompositeOperation = s.mode === "erase" ? "destination-out" : "source-over";
      ctx.strokeStyle = MASK_COLOR;
      ctx.lineWidth = Math.max(1, s.size);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const pts = s.points;
      const start = Math.max(fromIndex, 0);
      if (start === 0 && pts.length === 1) {
        // Single tap stamps a dab (single-pointer path, WCAG 2.5.7).
        ctx.arc(pts[0].x, pts[0].y, Math.max(0.5, s.size / 2), 0, Math.PI * 2);
        ctx.fillStyle = MASK_COLOR;
        ctx.fill();
      } else {
        const anchor = start === 0 ? pts[0] : pts[start - 1];
        ctx.moveTo(anchor.x, anchor.y);
        for (let i = start; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      ctx.restore();
    },
    []
  );

  /** Full vector replay (D2): clear, then repaint every stroke. */
  const replay = useCallback(() => {
    const mask = maskCanvasRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay) return;
    const mctx = mask.getContext("2d");
    const octx = overlay.getContext("2d");
    if (!mctx || !octx) return;
    mctx.clearRect(0, 0, mask.width, mask.height);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    for (const s of strokesRef.current) {
      paintStrokeOn(mctx, s, 0);
      paintStrokeOn(octx, s, 0);
    }
  }, [paintStrokeOn]);

  const loadSource = useCallback(
    async (url: string) => {
      setStatus("loading");
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const scale = Math.min(1, INPAINT_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const base = document.createElement("canvas");
        base.width = w;
        base.height = h;
        const bctx = base.getContext("2d");
        if (!bctx) throw new Error("Canvas not available.");
        bctx.drawImage(img, 0, 0, w, h);
        const mask = document.createElement("canvas");
        mask.width = w;
        mask.height = h;
        baseCanvasRef.current = base;
        maskCanvasRef.current = mask;
        strokesRef.current = [];
        redoRef.current = [];
        liveRef.current = null;
        loadedUrlRef.current = url;
        // Display canvases: React owns width/height attrs (setting them clears,
        // so the base is painted post-commit in the effect below). Clear the
        // overlay now for same-grid source swaps, where React won't reset it.
        overlayRef.current?.getContext("2d")?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
        setDims({ w, h });
        setVersion((v) => v + 1);
        notifyMask(0);
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    },
    [notifyMask]
  );

  // Source change: adopt directly when blank, else confirm via alertdialog.
  useEffect(() => {
    if (sourceUrl === loadedUrlRef.current) return;
    if (strokesRef.current.length === 0) {
      void loadSource(sourceUrl);
    } else {
      setPendingSource(sourceUrl);
    }
  }, [sourceUrl, loadSource]);

  useEffect(() => {
    if (loadedUrlRef.current === "") void loadSource(sourceUrl);
  }, []);

  // Paint the display base after React commits the grid size: assigning
  // width/height (directly or via re-render) clears the canvas, so drawing
  // must happen post-commit — never synchronously inside loadSource.
  useEffect(() => {
    if (dims.w === 0 || status === "loading") return;
    const base = baseCanvasRef.current;
    const baseEl = baseRef.current;
    if (!base || !baseEl) return;
    if (baseEl.width !== dims.w || baseEl.height !== dims.h) {
      baseEl.width = dims.w;
      baseEl.height = dims.h;
    }
    baseEl.getContext("2d")?.drawImage(base, 0, 0);
  }, [dims, status]);

  const eventPoint = useCallback((canvas: HTMLCanvasElement, clientX: number, clientY: number): Pt | null => {
    // Fresh rect per event: layout shifts (resize, sheet) must not skew mapping (N4a).
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) * canvas.width) / rect.width,
      y: ((clientY - rect.top) * canvas.height) / rect.height,
    };
  }, []);

  // Native pointer listeners ({passive:false}) so mobile painting never
  // scrolls the page; touch-action:none covers the canvas only (D14).
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const toPoints = (e: PointerEvent): Pt[] => {
      const out: Pt[] = [];
      const native = e as PointerEvent & {
        getCoalescedEvents?: () => PointerEvent[];
      };
      const samples =
        typeof native.getCoalescedEvents === "function" && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];
      for (const s of samples) {
        const p = eventPoint(canvas, s.clientX, s.clientY);
        if (p) out.push(p);
      }
      return out;
    };
    const drawLiveSegment = (s: Stroke, from: number) => {
      const mask = maskCanvasRef.current;
      const overlay = overlayRef.current;
      const mctx = mask?.getContext("2d");
      const octx = overlay?.getContext("2d");
      if (!mctx || !octx) return;
      paintStrokeOn(mctx, s, from);
      paintStrokeOn(octx, s, from);
    };
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (status !== "ready") return;
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported: stroke still works */
      }
      const pts = toPoints(e);
      if (pts.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const sizeImg =
        rect.width > 0 ? Math.max(1, (brushRef.current * canvas.width) / rect.width) : brushRef.current;
      const stroke: Stroke = { mode: modeRef.current, size: sizeImg, points: pts };
      liveRef.current = stroke;
      drawLiveSegment(stroke, 0);
    };
    const onMove = (e: PointerEvent) => {
      // Brush cursor preview (desktop): direct DOM move, no re-render.
      // Positioned from the OVERLAY canvas rect (D20) — the same frame the
      // paint mapping uses. The overlay is inset:0 in the wrap, so origins
      // match; containerRef must never be used for geometry (it includes
      // the toolbar, which used to push the ring a toolbar-height too low).
      const cursor = cursorRef.current;
      if (cursor) {
        const rect = canvas.getBoundingClientRect();
        if (e.pointerType === "mouse" && status === "ready" && !previewRef.current) {
          cursor.style.display = "block";
          const d = brushRef.current;
          cursor.style.width = `${d}px`;
          cursor.style.height = `${d}px`;
          cursor.style.transform = `translate(${e.clientX - rect.left - d / 2}px, ${e.clientY - rect.top - d / 2}px)`;
        } else {
          cursor.style.display = "none";
        }
      }
      const live = liveRef.current;
      if (!live || !e.isPrimary) return;
      e.preventDefault();
      const pts = toPoints(e);
      if (pts.length === 0) return;
      const from = live.points.length;
      live.points.push(...pts);
      drawLiveSegment(live, from);
    };
    const endStroke = (e: PointerEvent, commit: boolean) => {
      const live = liveRef.current;
      liveRef.current = null;
      if (!live || !e.isPrimary) return;
      if (!commit) {
        replay(); // pointercancel: drop the partial stroke
        return;
      }
      strokesRef.current.push(live);
      redoRef.current = [];
      setVersion((v) => v + 1);
      notifyMask(measureCoverage());
    };
    const onUp = (e: PointerEvent) => endStroke(e, true);
    const onCancel = (e: PointerEvent) => endStroke(e, false);
    const onLeave = () => {
      if (cursorRef.current) cursorRef.current.style.display = "none";
    };
    canvas.addEventListener("pointerdown", onDown, { passive: false });
    canvas.addEventListener("pointermove", onMove, { passive: false });
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [status, eventPoint, paintStrokeOn, replay, measureCoverage, notifyMask]);

  const undo = useCallback(() => {
    const s = strokesRef.current.pop();
    if (!s) return;
    redoRef.current.push(s);
    replay();
    setVersion((v) => v + 1);
    notifyMask(measureCoverage());
  }, [replay, measureCoverage, notifyMask]);

  const redo = useCallback(() => {
    const s = redoRef.current.pop();
    if (!s) return;
    strokesRef.current.push(s);
    replay();
    setVersion((v) => v + 1);
    notifyMask(measureCoverage());
  }, [replay, measureCoverage, notifyMask]);

  const clear = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    strokesRef.current = [];
    redoRef.current = [];
    replay();
    setVersion((v) => v + 1);
    notifyMask(0);
  }, [replay, notifyMask]);

  const setBrush = useCallback(
    (n: number) => {
      setBrushScreen(Math.min(MAX_BRUSH_SCREEN, Math.max(MIN_BRUSH_SCREEN, Math.round(n))));
      flashPreview();
    },
    [flashPreview]
  );

  // Wheel sizing (D22/N14): native listener {passive:false} on the Size
  // control only, so the page never scrolls under it. deltaMode normalised;
  // deltas accumulate (±50px → one ±2 step, Shift ×4) so trackpads glide
  // instead of jumping.
  const sizeWrapRef = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    const el = sizeWrapRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= window.innerHeight;
      acc += dy;
      const step = e.shiftKey ? 8 : 2;
      while (acc >= 50) {
        acc -= 50;
        setBrushScreen((b) => Math.max(MIN_BRUSH_SCREEN, b - step));
        flashPreview();
      }
      while (acc <= -50) {
        acc += 50;
        setBrushScreen((b) => Math.min(MAX_BRUSH_SCREEN, b + step));
        flashPreview();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [flashPreview]);

  // Shortcuts scoped to the editor container: never fire from the
  // instruction textarea (outside this tree).
  const onContainerKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (!mod && e.key === "[") {
      setBrush(brushRef.current - 8);
    } else if (!mod && e.key === "]") {
      setBrush(brushRef.current + 8);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      hasMask: () => strokesRef.current.length > 0,
      exportImages: async () => {
        const base = baseCanvasRef.current;
        const mask = maskCanvasRef.current;
        if (!base || !mask || loadedUrlRef.current === "") throw new Error("No source image loaded.");
        const original = encodeCanvas(base);
        const marked = document.createElement("canvas");
        marked.width = base.width;
        marked.height = base.height;
        const ctx = marked.getContext("2d");
        if (!ctx) throw new Error("Canvas not available.");
        ctx.drawImage(base, 0, 0);
        ctx.save();
        ctx.globalAlpha = MASK_ALPHA;
        ctx.drawImage(mask, 0, 0);
        ctx.restore();
        return { original, marked: encodeCanvas(marked), width: base.width, height: base.height };
      },
      getMaskCanvas: () => {
        const mask = maskCanvasRef.current;
        if (!mask) throw new Error("No source image loaded.");
        return mask;
      },
    }),
    []
  );

  const strokeCount = strokesRef.current.length;
  void version; // re-render trigger only; count is read from the ref
  const label =
    status === "ready"
      ? `Mask editor for ${sourceLabel}: ${strokeCount} stroke${strokeCount === 1 ? "" : "s"}, about ${Math.round(coverage * 100)}% of image marked`
      : `Mask editor for ${sourceLabel}`;

  return (
    <div ref={containerRef} className="mask-editor" onKeyDown={onContainerKey}>
      <div className="mask-toolbar" role="group" aria-label="Mask tools">
        <div className="seg" role="group" aria-label="Brush mode">
          <button
            type="button"
            className={mode === "paint" ? "active" : ""}
            aria-pressed={mode === "paint"}
            onClick={() => setMode("paint")}
          >
            Paint
          </button>
          <button
            type="button"
            className={mode === "erase" ? "active" : ""}
            aria-pressed={mode === "erase"}
            onClick={() => setMode("erase")}
          >
            Erase
          </button>
        </div>
        <label className="mask-size" ref={sizeWrapRef}>
          <span>
            Size <span aria-hidden="true">· {brushScreen}px</span>
          </span>
          <input
            type="range"
            min={MIN_BRUSH_SCREEN}
            max={MAX_BRUSH_SCREEN}
            step={2}
            value={brushScreen}
            aria-label={`Brush size, ${brushScreen} pixels on screen`}
            aria-valuetext={`${brushScreen} pixels`}
            onChange={(e) => setBrush(Number(e.target.value))}
          />
        </label>
        <span className="mask-history">
          <button type="button" className="btn btn-small" onClick={undo} disabled={strokeCount === 0}>
            Undo
          </button>
          <button type="button" className="btn btn-small" onClick={redo} disabled={redoRef.current.length === 0}>
            Redo
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={clear} disabled={strokeCount === 0}>
            Clear
          </button>
        </span>
      </div>
      <div className="mask-stage" role="img" aria-label={label}>
        {status === "loading" && <p className="mask-status">Loading image…</p>}
        {status === "error" && (
          <p className="mask-status" role="alert">
            Could not read that image. Pick another source.
          </p>
        )}
        <div className={status === "ready" ? "mask-canvas-wrap" : "mask-canvas-wrap is-hidden-canvas"}>
          <canvas ref={baseRef} className="mask-base" aria-hidden="true" width={dims.w} height={dims.h} />
          <canvas
            ref={overlayRef}
            className="mask-overlay"
            aria-hidden="true"
            width={dims.w}
            height={dims.h}
            style={{ opacity: MASK_ALPHA }}
          />
          <div ref={cursorRef} className="mask-cursor" aria-hidden="true" />
          {previewVisible && status === "ready" && (
            <div
              className="mask-size-preview"
              aria-hidden="true"
              style={{ width: brushScreen, height: brushScreen }}
            >
              <span className="mask-size-preview-label">{brushScreen} px</span>
            </div>
          )}
        </div>
      </div>
      {pendingSource !== null && (
        <Dialog
          role="alertdialog"
          labelledBy="discard-mask-title"
          describedBy="discard-mask-desc"
          onClose={() => setPendingSource(null)}
          overlayClassName="overlay overlay-top overlay-thumb"
        >
          <h3 id="discard-mask-title">Discard mask?</h3>
          <p id="discard-mask-desc">Switching images clears the current paint strokes.</p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-small" onClick={() => setPendingSource(null)}>
              Keep painting
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger"
              onClick={() => {
                const next = pendingSource;
                setPendingSource(null);
                void loadSource(next);
              }}
            >
              Discard
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
});

export default MaskEditor;
