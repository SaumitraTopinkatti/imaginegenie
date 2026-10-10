import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  broadcastLibChanged,
  clearReferences,
  decryptReference,
  deleteReference,
  encryptText,
  listRawReferences,
  saveReference,
  subscribeLibChanged,
  uid,
} from "../lib/secureStore";
import { copyImageDataUrl, downloadDataUrl, fileToDataUrl, isAccepted, makeThumb } from "../lib/images";
import {
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  EyeIcon,
  FolderIcon,
  SearchIcon,
  UploadIcon,
} from "./icons";

/**
 * Reference library tab. References are standalone: each one is encrypted in
 * its own IndexedDB store and is never soft-linked to generations, so deleting
 * one here cannot affect anything already generated with it.
 */

export interface ReferenceItem {
  id: string;
  createdAt: number;
  name: string;
  description: string;
  group: string;
  imageUrl: string;
  thumbUrl: string;
}

type SortBy = "newest" | "oldest" | "name" | "name-desc";

const SORTS: Array<{ value: SortBy; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
];

const NO_GROUP = "__none__";

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSize(dataUrl: string): string {
  const kb = Math.round(((dataUrl.length * 3) / 4 / 1024) * 10) / 10;
  return kb >= 1024 ? `${Math.round(kb / 1024 * 10) / 10} MB` : `${kb} KB`;
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

interface EditDraft {
  id: string;
  name: string;
  description: string;
  group: string;
}

export interface ReferencesTabProps {
  /** Load a reference into the composer and jump to the Studio tab. */
  onUseReference: (imageUrl: string) => void;
  /** Open the shared full-size image viewer. */
  onViewImage: (imageUrl: string) => void;
  pushToast: (kind: "ok" | "err" | "info", text: string) => void;
  onCountChange: (n: number) => void;
}

export default function ReferencesTab({
  onUseReference,
  onViewImage,
  pushToast,
  onCountChange,
}: ReferencesTabProps) {
  const [items, setItems] = useState<ReferenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [groupFilter, setGroupFilter] = useState("all");
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReferenceItem | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const raw = await listRawReferences();
      const out: ReferenceItem[] = [];
      for (const r of raw) {
        try {
          const { imageUrl, thumbUrl } = await decryptReference(r);
          out.push({
            id: r.id,
            createdAt: r.createdAt,
            name: r.name || "Reference",
            description: r.description || "",
            group: r.group || "",
            imageUrl,
            thumbUrl,
          });
        } catch {
          /* skip corrupt reference */
        }
      }
      setItems(out);
      return out.length;
    } catch {
      pushToast("err", "Could not open the encrypted reference library.");
      return -1;
    }
  }, [pushToast]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    onCountChange(items.length);
  }, [items.length, onCountChange]);

  /* multi-tab: another tab changed the library -> re-list silently */
  useEffect(() => subscribeLibChanged(() => void reload()), [reload]);

  /* upload: from dropzone, file picker or the clipboard */
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0 || busy) return;
      const bad = list.filter((f) => !isAccepted(f));
      if (bad.length > 0) {
        pushToast("err", "Only PNG, JPG or WebP files.");
        return;
      }
      setBusy(true);
      try {
        const base = Date.now();
        let added = 0;
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          const imageUrl = await fileToDataUrl(f);
          const thumbUrl = await makeThumb(imageUrl).catch(() => imageUrl);
          await saveReference({
            id: uid(),
            createdAt: base + i, // keep intra-batch ordering stable
            name: stripExt(f.name).slice(0, 80) || "Reference",
            description: "",
            group: "",
            imageEnc: await encryptText(imageUrl),
            thumbEnc: await encryptText(thumbUrl),
          });
          added++;
        }
        await reload();
        broadcastLibChanged();
        pushToast("ok", `${added} reference${added === 1 ? "" : "s"} saved to the library.`);
      } catch {
        pushToast("err", "Could not save that image.");
      } finally {
        setBusy(false);
      }
    },
    [busy, pushToast, reload]
  );

  /* paste images straight into the library while this tab is open */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return; // text-only paste: stay out entirely
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return; // no image items: never preventDefault
      void addFiles(images);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addFiles]);

  /* Esc closes the reference dialogs, mirroring the app-level Escape handler */
  useEffect(() => {
    if (!pendingDelete && !confirmClear) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPendingDelete(null);
      setConfirmClear(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pendingDelete, confirmClear]);

  const saveDraft = async () => {
    if (!draft) return;
    const target = items.find((i) => i.id === draft.id);
    if (!target) return;
    const name = draft.name.trim().slice(0, 80);
    const description = draft.description.trim().slice(0, 400);
    const group = draft.group.trim().slice(0, 40);
    setDraft(null);
    setItems((cur) =>
      cur.map((i) => (i.id === target.id ? { ...i, name, description, group } : i))
    );
    try {
      const raw = await listRawReferences();
      const rec = raw.find((r) => r.id === target.id);
      if (!rec) throw new Error("missing");
      await saveReference({ ...rec, name, description, group });
      broadcastLibChanged();
    } catch {
      pushToast("err", "Could not save the changes.");
      void reload();
    }
  };

  const remove = async (item: ReferenceItem) => {
    setPendingDelete(null);
    setItems((cur) => cur.filter((i) => i.id !== item.id));
    try {
      await deleteReference(item.id);
      broadcastLibChanged();
      pushToast("ok", "Reference deleted.");
    } catch {
      pushToast("err", "Delete failed in storage.");
      void reload();
    }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    setItems([]);
    try {
      await clearReferences();
      const remaining = await listRawReferences();
      if (remaining.length === 0) pushToast("ok", "Reference library cleared.");
      else await reload();
      broadcastLibChanged();
    } catch {
      pushToast("err", "Clear failed in storage.");
      void reload();
    }
  };

  const copyRef = async (imageUrl: string) => {
    try {
      await copyImageDataUrl(imageUrl);
      pushToast("ok", "Image copied.");
    } catch {
      pushToast("err", "Copy failed in this browser.");
    }
  };

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.group) set.add(i.group);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = items.filter((i) => {
      if (groupFilter === NO_GROUP && i.group) return false;
      if (groupFilter !== "all" && groupFilter !== NO_GROUP && i.group !== groupFilter) {
        return false;
      }
      if (q && !`${i.name} ${i.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const byName = (a: ReferenceItem, b: ReferenceItem) =>
      a.name.localeCompare(b.name) || a.createdAt - b.createdAt;
    if (sortBy === "newest") return [...out].sort((a, b) => b.createdAt - a.createdAt);
    if (sortBy === "oldest") return [...out].sort((a, b) => a.createdAt - b.createdAt);
    if (sortBy === "name-desc") return [...out].sort((a, b) => byName(b, a));
    return [...out].sort(byName);
  }, [items, search, groupFilter, sortBy]);

  return (
    <>
      <section className="panel refs-panel" aria-label="Reference library">
        <div className="refs-drop">
          <div
            className={dragOver ? "dropzone over" : "dropzone"}
            role="button"
            tabIndex={0}
            aria-label="Upload reference images to the library"
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
            <div className="dz-title">
              {busy ? "Saving…" : "Drop images here, click to browse, or paste from clipboard"}
            </div>
            <div className="dz-sub">
              PNG · JPG · WebP — resized to max 2048px in browser, then encrypted locally
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
        </div>

        <div className="gallery-bar">
          <div className="search">
            <span className="icon">
              <SearchIcon size={16} />
            </span>
            <input
              type="text"
              aria-label="Search references"
              placeholder="Search names and descriptions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            style={{ width: "auto" }}
            title="Filter by group"
            aria-label="Filter by group"
          >
            <option value="all">All groups</option>
            <option value={NO_GROUP}>Ungrouped</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            style={{ width: "auto" }}
            title="Sort references"
            aria-label="Sort references"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="tool-row">
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={items.length === 0 || busy}
              onClick={() => setConfirmClear(true)}
            >
              <DeleteIcon size={14} /> Clear
            </button>
          </div>
        </div>

        <datalist id="ref-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>

        {loading ? (
          <div className="grid">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div className="skel" key={i}>
                <div className="ph" />
                <div className="ln" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <h3>{items.length === 0 ? "No references yet" : "Nothing matches"}</h3>
            <p>
              {items.length === 0
                ? "Upload images here to reuse them as generation references. They stay encrypted in this browser and are never linked to your generations."
                : "Try a different search or group filter."}
            </p>
          </div>
        ) : (
          <div className="grid">
            {visible.map((r) => {
              const editing = draft?.id === r.id;
              return (
                <article className={editing ? "card ref-card editing" : "card ref-card"} key={r.id}>
                  <button
                    type="button"
                    className="thumb"
                    title="View full size"
                    aria-label={`View ${r.name} full size`}
                    onClick={() => onViewImage(r.imageUrl)}
                  >
                    <img src={r.thumbUrl} alt={r.name} loading="lazy" />
                    <span className="size-tag">{fmtSize(r.imageUrl)}</span>
                  </button>
                  <div className="body">
                    {editing ? (
                      <div className="ref-edit">
                        <input
                          type="text"
                          aria-label="Reference name"
                          placeholder="Name"
                          maxLength={80}
                          value={draft!.name}
                          onChange={(e) => setDraft({ ...draft!, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveDraft();
                            if (e.key === "Escape") setDraft(null);
                          }}
                        />
                        <textarea
                          aria-label="Reference description"
                          placeholder="Description (optional)"
                          maxLength={400}
                          value={draft!.description}
                          onChange={(e) => setDraft({ ...draft!, description: e.target.value })}
                        />
                        <input
                          type="text"
                          list="ref-groups"
                          aria-label="Reference group"
                          placeholder="Group (optional)"
                          maxLength={40}
                          value={draft!.group}
                          onChange={(e) => setDraft({ ...draft!, group: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveDraft();
                            if (e.key === "Escape") setDraft(null);
                          }}
                        />
                        <div className="ref-edit-actions">
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            onClick={() => setDraft(null)}
                          >
                            Cancel
                          </button>
                          <button type="button" className="btn btn-small" onClick={() => void saveDraft()}>
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="name" title={r.name}>
                          {r.name}
                        </div>
                        <div className="desc">{r.description}</div>
                        <div className="meta">
                          {r.group && (
                            <span className="tag group-tag">
                              <FolderIcon size={10} /> {r.group}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-small ref-use"
                          onClick={() => onUseReference(r.imageUrl)}
                        >
                          <UploadIcon size={14} /> Use as reference
                        </button>
                        <div className="foot">
                          <span className="time">Added {fmtTime(r.createdAt)}</span>
                          <span className="actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="View full size"
                              aria-label={`View ${r.name} full size`}
                              onClick={() => onViewImage(r.imageUrl)}
                            >
                              <EyeIcon size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Edit name, description or group"
                              aria-label={`Edit ${r.name}`}
                              onClick={() =>
                                setDraft({
                                  id: r.id,
                                  name: r.name,
                                  description: r.description,
                                  group: r.group,
                                })
                              }
                            >
                              <EditIcon size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Copy image"
                              aria-label={`Copy ${r.name}`}
                              onClick={() => void copyRef(r.imageUrl)}
                            >
                              <CopyIcon size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Download PNG"
                              aria-label={`Download ${r.name}`}
                              onClick={() =>
                                downloadDataUrl(r.imageUrl, `imaginegenie-ref-${r.id.slice(0, 8)}.png`)
                              }
                            >
                              <DownloadIcon size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Delete"
                              aria-label={`Delete ${r.name}`}
                              onClick={() => setPendingDelete(r)}
                            >
                              <DeleteIcon size={15} />
                            </button>
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {pendingDelete && (
        <div className="overlay overlay-top" onClick={() => setPendingDelete(null)}>
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ref-del-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ref-del-title">Delete this reference?</h3>
            <p>
              Removes “{pendingDelete.name}” from the encrypted library. Images already generated
              with it are not affected.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => void remove(pendingDelete)}
              >
                <DeleteIcon size={14} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmClear && (
        <div className="overlay overlay-top" onClick={() => setConfirmClear(false)}>
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ref-clear-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ref-clear-title">Delete all {items.length} references?</h3>
            <p>
              This removes every saved reference from the encrypted library. Images already
              generated with them are not affected.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => void clearAll()}
              >
                <DeleteIcon size={14} /> Delete all
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
