import { useEffect, useRef } from "react";

/**
 * Denoise-style generation placeholder (from the Denoise Loader concept).
 * Teal pixel blocks fade in and drift upward on a sunk background while the
 * model works; when `done` flips true they thin out and clear to an empty
 * dashed frame, then `onClean` fires so the parent can swap in the image.
 */

export interface DenoiseFrameProps {
  seed?: number;
  cols?: number;
  rows?: number;
  /** CSS aspect-ratio value, e.g. "16 / 9". */
  aspect?: string;
  /** When true, the loader finishes: thins out, clears, calls onClean. */
  done?: boolean;
  onClean?: () => void;
  label?: string;
}

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function noise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function smooth(a: number): number {
  const c = a < 0 ? 0 : a > 1 ? 1 : a;
  return c * c * (3 - 2 * c);
}

const PX = "#13A08C";
const AMP = 0.7;
const DRIFT = 0.55;

export default function DenoiseFrame({
  seed = 11,
  cols = 12,
  rows = 12,
  aspect = "1 / 1",
  done = false,
  onClean,
  label = "Image generating",
}: DenoiseFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(done);
  doneRef.current = done;
  const cleanRef = useRef(onClean);
  cleanRef.current = onClean;

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 1;
    let h = 1;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = frame.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = "ResizeObserver" in window ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(frame);

    // Start empty so blocks float in.
    let d = -0.4;
    let t0: number | null = null;
    let last = performance.now();
    let finishing = false;
    let cleaned = false;
    let raf = 0;

    const draw = (t: number) => {
      const cw = w / cols;
      const ch = h / rows;
      const drift = reduceMotion() ? 0 : DRIFT;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = PX;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const th = hash(i, j, seed);
          const n = noise(i * 0.34, j * 0.34 + t * drift, seed + 7);
          const a = smooth((d + (n - 0.5) * AMP - th) / 0.16);
          if (a < 0.01) continue;
          const alpha = a * (0.42 + 0.58 * hash(i, j, seed + 3));
          // Blocks float up as they fade.
          const lift = reduceMotion() ? 0 : (1 - a) * ch * 0.45;
          ctx.globalAlpha = alpha;
          ctx.fillRect(
            Math.floor(i * cw),
            Math.floor(j * ch - lift),
            Math.ceil(cw) + 0.5,
            Math.ceil(ch) + 0.5
          );
        }
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (cleaned) return;
      if (t0 === null) t0 = now;
      const el = (now - t0) / 1000;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (doneRef.current) finishing = true;
      // Loop mode: density breathes until done; finishing drains to empty.
      const target = finishing
        ? -0.45
        : 0.55 + 0.26 * Math.sin(el * 0.85) + 0.08 * Math.sin(el * 2.3 + 1.3);
      const rate = finishing ? 3.2 : 2.4;
      d += (target - d) * Math.min(1, dt * rate);
      if (finishing && d < -0.38) {
        cleaned = true;
        ctx.clearRect(0, 0, w, h);
        frame.classList.add("clean");
        cleanRef.current?.();
        return;
      }
      draw(reduceMotion() ? Math.floor(el / 0.9) * 0.9 : el);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [seed, cols, rows]);

  return (
    <div
      ref={frameRef}
      className="denoise-frame"
      style={{ aspectRatio: aspect }}
      role="img"
      aria-label={label}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
