import { useEffect, useState } from "react";
import Dialog from "./Dialog";
import { CloseIcon } from "./icons";
import type { Generation, InpaintSource } from "../lib/types";
import { listReferenceThumbs, loadReferenceImage, type ReferenceThumb } from "../lib/library";

/**
 * "Choose image" picker for Inpaint (N5/N11): Generations (already decrypted
 * in App) and References (thumbs-only list, full image decrypted on pick).
 *
 * A surfaced flex-column modal: fixed header (title, close, segment) and
 * footer (Cancel); only the grid body scrolls. Thumbs carry one-line
 * captions so identical-looking images can be told apart.
 */

export interface SourcePickerProps {
  generations: Generation[];
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
  onPick: (source: InpaintSource) => void;
  onClose: () => void;
}

type Segment = "generations" | "references";

function snippetOf(g: Generation): string {
  return g.inpaint?.instruction || g.prompt || "Generated image";
}

export default function SourcePicker({ generations, pushToast, onPick, onClose }: SourcePickerProps) {
  const [segment, setSegment] = useState<Segment>("generations");
  const [refs, setRefs] = useState<ReferenceThumb[] | null>(null);
  const [refsError, setRefsError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (segment !== "references" || refs !== null) return;
    void (async () => {
      try {
        const thumbs = await listReferenceThumbs();
        if (!cancelled) setRefs(thumbs);
      } catch {
        if (!cancelled) setRefsError("Could not read the reference library.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segment, refs]);

  const pickReference = async (r: ReferenceThumb) => {
    if (busyId !== null) return;
    setBusyId(r.id);
    try {
      const url = await loadReferenceImage(r.id);
      onPick({ url, kind: "reference", id: r.id, label: r.name || "Reference" });
    } catch {
      pushToast("err", "Could not decrypt that reference.");
      setBusyId(null);
    }
  };

  const body =
    segment === "generations" ? (
      generations.length === 0 ? (
        <p className="picker-empty">No generations yet — generate in Studio first.</p>
      ) : (
        <div className="picker-grid">
          {generations.map((g) => {
            const caption = snippetOf(g).slice(0, 60);
            return (
              <button
                key={g.id}
                type="button"
                className="picker-thumb"
                aria-label={`Use image: ${snippetOf(g).slice(0, 100)}`}
                title={caption}
                onClick={() => onPick({ url: g.imageUrl, kind: "generation", id: g.id, label: caption })}
              >
                <img src={g.thumbUrl} alt="" loading="lazy" />
                <span className="picker-cap">{caption}</span>
              </button>
            );
          })}
        </div>
      )
    ) : refs === null && refsError === "" ? (
      <p className="picker-empty">Loading references…</p>
    ) : refsError !== "" ? (
      <p className="picker-empty" role="alert">
        {refsError}
      </p>
    ) : refs !== null && refs.length === 0 ? (
      <p className="picker-empty">No references yet — add some in References first.</p>
    ) : (
      <div className="picker-grid">
        {(refs ?? []).map((r) => {
          const caption = r.name || "untitled";
          return (
            <button
              key={r.id}
              type="button"
              className="picker-thumb"
              aria-label={`Use reference ${caption}`}
              title={caption}
              disabled={busyId !== null}
              onClick={() => void pickReference(r)}
            >
              <img src={r.thumbUrl} alt="" loading="lazy" />
              <span className="picker-cap">{caption}</span>
              {busyId === r.id && <span className="picker-busy">Loading…</span>}
            </button>
          );
        })}
      </div>
    );

  return (
    <Dialog label="Choose image" onClose={onClose} panelClassName="confirm-card picker-card">
      <div className="picker-head">
        <h3>Choose image</h3>
        <button type="button" className="icon-btn" aria-label="Close image picker" onClick={onClose}>
          <CloseIcon size={15} />
        </button>
      </div>
      <div className="seg" role="group" aria-label="Image source">
        <button
          type="button"
          className={segment === "generations" ? "active" : ""}
          aria-pressed={segment === "generations"}
          onClick={() => setSegment("generations")}
        >
          Generations · {generations.length}
        </button>
        <button
          type="button"
          className={segment === "references" ? "active" : ""}
          aria-pressed={segment === "references"}
          onClick={() => setSegment("references")}
        >
          References{refs !== null ? ` · ${refs.length}` : ""}
        </button>
      </div>
      <div className="picker-body">{body}</div>
      <div className="confirm-actions">
        <button type="button" className="btn btn-small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
