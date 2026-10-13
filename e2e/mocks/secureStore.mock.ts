/**
 * In-memory stand-in for `src/lib/secureStore.ts`, used ONLY in the e2e
 * build (vite `--mode e2e` aliases `src/lib/secureStore` to this file).
 *
 * - No IndexedDB, no WebCrypto: "encryption" is reversible base64 tagging
 *   with the same `EncryptedPayload` shape and `AES-GCM-256` alg label.
 * - Same cross-tab contract: `broadcastLibChanged`/`subscribeLibChanged`
 *   run over a REAL `BroadcastChannel` on the same channel name, so two
 *   Playwright pages in one context stay in sync.
 * - Backup format mirrors the real one (same app/schema fields, passphrase
 *   minimum, wrong-passphrase rejection, legacy no-keywrap path, unreadable
 *   counting) but the wrap is a self-consistent mock — NOT real PBKDF2 and
 *   NOT portable to the production store.
 * - Test-only control surface `window.__e2e__` is installed by this module,
 *   so it exists only in bundles built with the alias. The sentinel string
 *   `IMAGINEGENIE_E2E_MOCK` below must never appear in a production `dist/`
 *   (`scripts/e2e-sentinel.mjs` enforces both directions).
 */

import type * as Real from "../../src/lib/secureStore";
import type {
  BackupFile,
  BackupKeyWrap,
  DecryptedRecord,
  DecryptedReference,
  EncryptedPayload,
  ImportResult,
  StoredRecord,
  StoredReference,
} from "../../src/lib/secureStore";

export type {
  BackupFile,
  BackupKeyWrap,
  DecryptedRecord,
  DecryptedReference,
  EncryptedPayload,
  ImportCounts,
  ImportResult,
  StoredRecord,
  StoredReference,
} from "../../src/lib/secureStore";

export const BACKUP_MIN_PASSPHRASE = 8;
const BACKUP_MOCK_ITERATIONS = 600_000;

const LIB_CHANNEL = "imaginegenie-lib";
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/**
 * Origin-shared mirror (localStorage) so two pages in one context see the
 * same library, matching the real IndexedDB store. Kept as plain JSON of
 * the same payload shapes; the live source of truth stays the in-memory
 * Maps. Degraded flag persists too because the app reads it once at startup
 * (degraded-banner tests set it, then reload).
 */
const LS_KEY = "imaginegenie-e2e-mock-v1";

/* ---------- in-memory state ---------- */

const records = new Map<string, StoredRecord>();
const references = new Map<string, StoredReference>();
let apiKeyPayload: EncryptedPayload | null = null;
let degradedReason = "";
/** One-shot storage failures injected via `__e2e__.failNext(op)`. */
let failNextOp: string | null = null;
/** Fixed mock device key (16 bytes); only its presence/absence matters. */
const DEVICE_KEY_B64 = "bW9jay1kZXZpY2Uta2V5MQ==";

function persist(): void {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        records: [...records.values()],
        references: [...references.values()],
        apiKeyPayload,
        degradedReason,
      })
    );
  } catch {
    /* storage full/blocked: tests keep in-memory state */
  }
}

function hydrate(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const j = JSON.parse(raw) as {
      records?: StoredRecord[];
      references?: StoredReference[];
      apiKeyPayload?: EncryptedPayload | null;
      degradedReason?: string;
    };
    records.clear();
    for (const r of j.records ?? []) records.set(r.id, r);
    references.clear();
    for (const r of j.references ?? []) references.set(r.id, r);
    apiKeyPayload = j.apiKeyPayload ?? null;
    degradedReason = j.degradedReason ?? "";
  } catch {
    /* corrupt mirror: start empty */
  }
}

try {
  hydrate();
} catch {
  /* no localStorage (odd context): memory only */
}

function strToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToStr(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Tiny non-crypto hash chain for the mock keywrap verifier (NOT PBKDF2). */
function mockHash(salt: string, pass: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = `${salt}::${pass}`;
  for (let round = 0; round < 200; round++) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i) + round;
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 + c, 2246822519);
    }
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

function maybeFail(op: "save" | "delete" | "clear"): void {
  if (failNextOp === op) {
    failNextOp = null;
    throw new Error(`Mock storage failure (${op}).`);
  }
}

/* ---------- crypto-mode surface ---------- */

export function initCrypto(): Promise<"AES-GCM-256" | "XOR"> {
  return Promise.resolve(degradedReason ? "XOR" : "AES-GCM-256");
}

export function cryptoDegraded(): string {
  return degradedReason;
}

export function cryptoMode(): string {
  return degradedReason ? "XOR" : "AES-GCM-256";
}

export async function getDeviceKeyRaw(): Promise<Uint8Array<ArrayBuffer>> {
  if (degradedReason) throw new Error("Encryption unavailable — backup needs AES-GCM.");
  const bin = atob(DEVICE_KEY_B64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptText(plain: string): Promise<EncryptedPayload> {
  // Mirrors the real store: writes refuse loudly when degraded.
  if (degradedReason) throw new Error("Encryption unavailable — new data cannot be saved.");
  return { iv: "mock", data: strToB64(plain), alg: "AES-GCM-256" };
}

export async function decryptText(p: EncryptedPayload): Promise<string> {
  if (!p || typeof p.data !== "string") throw new Error("Unreadable item.");
  if (p.alg !== "AES-GCM-256" || p.iv !== "mock") throw new Error("Unreadable item.");
  try {
    return b64ToStr(p.data);
  } catch {
    throw new Error("Unreadable item.");
  }
}

/* ---------- API-key payload ---------- */

export async function saveApiKeyPayload(p: EncryptedPayload): Promise<void> {
  maybeFail("save");
  apiKeyPayload = { ...p };
  persist();
}

export async function loadApiKeyPayload(): Promise<EncryptedPayload | null> {
  return apiKeyPayload ? { ...apiKeyPayload } : null;
}

export async function clearApiKeyPayload(): Promise<void> {
  apiKeyPayload = null;
  persist();
}

/* ---------- records ---------- */

export async function saveRecord(r: StoredRecord): Promise<void> {
  maybeFail("save");
  records.set(r.id, r);
  persist();
}

export async function listRawRecords(): Promise<StoredRecord[]> {
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRecord(id: string): Promise<void> {
  maybeFail("delete");
  records.delete(id);
  persist();
}

export async function clearRecords(): Promise<void> {
  maybeFail("clear");
  records.clear();
  persist();
}

export async function decryptRecord(r: StoredRecord): Promise<DecryptedRecord> {
  const imageUrl = await decryptText(r.imageEnc);
  let thumbUrl = imageUrl;
  try {
    thumbUrl = await decryptText(r.thumbEnc);
  } catch {
    thumbUrl = imageUrl;
  }
  const refUrls: string[] = [];
  if (Array.isArray(r.refsEnc)) {
    for (const p of r.refsEnc) {
      try {
        refUrls.push(await decryptText(p));
      } catch {
        /* skip corrupt ref */
      }
    }
  }
  return { imageUrl, thumbUrl, refUrls };
}

/* ---------- references ---------- */

export async function saveReference(r: StoredReference): Promise<void> {
  maybeFail("save");
  references.set(r.id, r);
  persist();
}

export async function listRawReferences(): Promise<StoredReference[]> {
  return [...references.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteReference(id: string): Promise<void> {
  maybeFail("delete");
  references.delete(id);
  persist();
}

export async function clearReferences(): Promise<void> {
  maybeFail("clear");
  references.clear();
  persist();
}

export async function decryptReference(r: StoredReference): Promise<DecryptedReference> {
  const imageUrl = await decryptText(r.imageEnc);
  let thumbUrl = imageUrl;
  try {
    thumbUrl = await decryptText(r.thumbEnc);
  } catch {
    thumbUrl = imageUrl;
  }
  return { imageUrl, thumbUrl };
}

/* ---------- backups (self-consistent mock format) ---------- */

function validRecord(r: unknown): r is StoredRecord {
  const v = r as StoredRecord;
  return !!v && typeof v.id === "string" && !!v.imageEnc && typeof v.imageEnc.data === "string";
}

function validReference(r: unknown): r is StoredReference {
  const v = r as StoredReference;
  return !!v && typeof v.id === "string" && !!v.imageEnc && typeof v.imageEnc.data === "string";
}

function validWrap(w: unknown): w is BackupKeyWrap {
  const v = w as BackupKeyWrap;
  return (
    !!v &&
    typeof v.salt === "string" &&
    typeof v.iv === "string" &&
    typeof v.wrappedKey === "string" &&
    Number.isInteger(v.iterations) &&
    v.iterations >= 100_000
  );
}

function parseBackupFile(jsonText: string): {
  records: StoredRecord[];
  references: StoredReference[];
  keyWrap?: BackupKeyWrap;
} {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(jsonText) as BackupFile;
  } catch {
    throw new Error("Not a valid backup file.");
  }
  if (!parsed || parsed.app !== "imaginegenie" || !Array.isArray(parsed.records)) {
    throw new Error("Not a valid backup file.");
  }
  const refs = Array.isArray(parsed.references) ? parsed.references : [];
  let keyWrap: BackupKeyWrap | undefined;
  if (parsed.keyWrap !== undefined) {
    if (!validWrap(parsed.keyWrap)) throw new Error("Not a valid backup file.");
    keyWrap = parsed.keyWrap;
  }
  return {
    records: parsed.records.filter(validRecord),
    references: refs.filter(validReference),
    keyWrap,
  };
}

export function peekBackup(jsonText: string): {
  records: number;
  references: number;
  hasKeyWrap: boolean;
} {
  const p = parseBackupFile(jsonText);
  return { records: p.records.length, references: p.references.length, hasKeyWrap: !!p.keyWrap };
}

async function wrapDeviceKey(pass: string): Promise<BackupKeyWrap> {
  if (pass.length < BACKUP_MIN_PASSPHRASE) {
    throw new Error(`Passphrase must be at least ${BACKUP_MIN_PASSPHRASE} characters.`);
  }
  await getDeviceKeyRaw(); // throws degraded, mirroring the real store
  const salt = `mock-salt-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`;
  return {
    salt,
    iterations: BACKUP_MOCK_ITERATIONS,
    iv: "mock",
    wrappedKey: `${DEVICE_KEY_B64}.${mockHash(salt, pass)}`,
  };
}

function unwrapDeviceKey(pass: string, w: BackupKeyWrap): void {
  const [key, verifier] = w.wrappedKey.split(".");
  if (key !== DEVICE_KEY_B64 || verifier !== mockHash(w.salt, pass)) {
    throw new Error("Wrong passphrase or corrupt backup — nothing imported.");
  }
}

export async function exportBackup(passphrase: string): Promise<string> {
  const keyWrap = await wrapDeviceKey(passphrase);
  const file: BackupFile = {
    app: "imaginegenie",
    schemaVersion: 2,
    version: 1,
    exportedAt: new Date().toISOString(),
    records: await listRawRecords(),
    references: await listRawReferences(),
    keyWrap,
  };
  return JSON.stringify(file);
}

export async function importBackup(jsonText: string, passphrase = ""): Promise<ImportResult> {
  const parsed = parseBackupFile(jsonText);
  const total = parsed.records.length + parsed.references.length;
  if (total === 0) return { records: 0, references: 0, unreadable: 0, legacy: !parsed.keyWrap };

  if (parsed.keyWrap) {
    if (!passphrase) throw new Error("This backup needs its passphrase — nothing imported.");
    try {
      unwrapDeviceKey(passphrase, parsed.keyWrap);
    } catch {
      throw new Error("Wrong passphrase or corrupt backup — nothing imported.");
    }
    // Trial-decrypt the first payload BEFORE writing anything (mirrors real).
    try {
      const first = parsed.records[0] ?? parsed.references[0];
      if (first) await decryptText(first.imageEnc);
    } catch {
      throw new Error("Wrong passphrase or corrupt backup — nothing imported.");
    }
    // Mock "encryption" is device-independent: rows import verbatim, per-row
    // failures counted, never stored silently.
    let n = 0;
    let rn = 0;
    let unreadable = 0;
    for (const r of parsed.records) {
      try {
        await decryptText(r.imageEnc);
        records.set(r.id, r);
        n += 1;
      } catch {
        unreadable += 1;
      }
    }
    for (const r of parsed.references) {
      try {
        await decryptText(r.imageEnc);
        references.set(r.id, r);
        rn += 1;
      } catch {
        unreadable += 1;
      }
    }
    persist();
    return { records: n, references: rn, unreadable, legacy: false };
  }

  // Legacy backup (no wrapped key): only locally-decryptable rows import.
  const goodRecords: StoredRecord[] = [];
  const goodRefs: StoredReference[] = [];
  for (const r of parsed.records) {
    try {
      await decryptText(r.imageEnc);
      goodRecords.push(r);
    } catch {
      /* counted below */
    }
  }
  for (const r of parsed.references) {
    try {
      await decryptText(r.imageEnc);
      goodRefs.push(r);
    } catch {
      /* counted below */
    }
  }
  const unreadable = total - goodRecords.length - goodRefs.length;
  if (goodRecords.length === 0 && goodRefs.length === 0) {
    throw new Error(
      "Nothing in this backup decrypts on this device — old backups restore only where made. Nothing imported."
    );
  }
  for (const r of goodRecords) records.set(r.id, r);
  for (const r of goodRefs) references.set(r.id, r);
  persist();
  return { records: goodRecords.length, references: goodRefs.length, unreadable, legacy: true };
}

export function countBackupRecords(json: string): number {
  const p = parseBackupFile(json);
  return p.records.length + p.references.length;
}

export function countBackupReferences(json: string): number {
  return parseBackupFile(json).references.length;
}

/* ---------- cross-tab sync (real BroadcastChannel, same name as prod) ---------- */

export function broadcastLibChanged(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(LIB_CHANNEL);
    ch.postMessage({ type: "imaginegenie-lib-changed", at: Date.now(), tabId: TAB_ID });
    ch.close();
  } catch {
    /* unsupported — skip silently */
  }
}

export function subscribeLibChanged(cb: () => void): () => void {
  try {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    const ch = new BroadcastChannel(LIB_CHANNEL);
    ch.onmessage = (e) => {
      if (e?.data?.tabId === TAB_ID) return;
      // Shared mirror changed under us: re-read before the app re-lists.
      try {
        hydrate();
      } catch {
        /* keep in-memory state */
      }
      cb();
    };
    return () => {
      try {
        ch.close();
      } catch {
        /* noop */
      }
    };
  } catch {
    return () => undefined;
  }
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Compile-time API-drift guard: assigning every export to the real module's
 * type fails `tsc` when an export is missing, renamed, or type-incompatible.
 */
const _apiCheck: typeof Real = {
  BACKUP_MIN_PASSPHRASE,
  initCrypto,
  cryptoDegraded,
  cryptoMode,
  saveApiKeyPayload,
  loadApiKeyPayload,
  clearApiKeyPayload,
  getDeviceKeyRaw,
  encryptText,
  decryptText,
  saveRecord,
  listRawRecords,
  deleteRecord,
  clearRecords,
  saveReference,
  listRawReferences,
  deleteReference,
  clearReferences,
  decryptReference,
  peekBackup,
  exportBackup,
  importBackup,
  countBackupRecords,
  countBackupReferences,
  broadcastLibChanged,
  subscribeLibChanged,
  decryptRecord,
  uid,
};
void _apiCheck;

/* ---------- test-only control surface (e2e build only) ---------- */

export interface E2eSeedRecord {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  cost?: number;
  mediaType?: string;
  refCount?: number;
  seed?: number;
  createdAt?: number;
  /** Full data URL; defaults to a 1px PNG when omitted. */
  imageUrl?: string;
  thumbUrl?: string;
  /** Reference data URLs stored with the generation (lightbox refs row). */
  refImageUrls?: string[];
  /** Inpaint metadata carried on the record (N2: seeded inpaint rendering). */
  inpaint?: StoredRecord["inpaint"];
}

export interface E2eSeedReference {
  name?: string;
  description?: string;
  group?: string;
  createdAt?: number;
  imageUrl?: string;
  thumbUrl?: string;
}

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function corruptPayload(p: EncryptedPayload): EncryptedPayload {
  return { ...p, data: "!!!corrupt!!!" };
}

async function e2eSeed(seed: {
  records?: E2eSeedRecord[];
  references?: E2eSeedReference[];
}): Promise<{ recordIds: string[]; referenceIds: string[] }> {
  const base = Date.now();
  const recordIds: string[] = [];
  const referenceIds: string[] = [];
  for (const [i, r] of (seed.records ?? []).entries()) {
    const imageUrl = r.imageUrl ?? PIXEL;
    const id = `seed-rec-${base}-${i}`;
    records.set(id, {
      id,
      createdAt: r.createdAt ?? base - i * 1000,
      prompt: r.prompt,
      aspectRatio: r.aspectRatio ?? "1:1",
      resolution: r.resolution ?? "1K",
      cost: r.cost ?? 0.045,
      mediaType: r.mediaType ?? "image/png",
      refCount: r.refCount ?? 0,
      seed: r.seed,
      imageEnc: await encryptText(imageUrl),
      thumbEnc: await encryptText(r.thumbUrl ?? imageUrl),
      refsEnc: r.refImageUrls
        ? await Promise.all(r.refImageUrls.map((u) => encryptText(u)))
        : undefined,
      inpaint: r.inpaint,
    });
    recordIds.push(id);
  }
  for (const [i, r] of (seed.references ?? []).entries()) {
    const imageUrl = r.imageUrl ?? PIXEL;
    const id = `seed-ref-${base}-${i}`;
    references.set(id, {
      id,
      createdAt: r.createdAt ?? base - i * 1000,
      name: r.name ?? `Seed ${i + 1}`,
      description: r.description ?? "",
      group: r.group ?? "",
      imageEnc: await encryptText(imageUrl),
      thumbEnc: await encryptText(r.thumbUrl ?? imageUrl),
    });
    referenceIds.push(id);
  }
  persist();
  broadcastLibChanged();
  return { recordIds, referenceIds };
}

function e2eReset(): void {
  records.clear();
  references.clear();
  apiKeyPayload = null;
  degradedReason = "";
  failNextOp = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* noop */
  }
  broadcastLibChanged();
}

export interface E2eControl {
  seed: (s: { records?: E2eSeedRecord[]; references?: E2eSeedReference[] }) => Promise<{
    recordIds: string[];
    referenceIds: string[];
  }>;
  reset: () => void;
  setDegraded: (reason: string | null) => void;
  markUnreadable: (ids: string[]) => void;
  failNext: (op: "save" | "delete" | "clear") => void;
}

if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  // Sentinel: proves the mock is bundled (dist-e2e) — must be ABSENT from dist/.
  w.__IMAGINEGENIE_E2E_MOCK__ = "IMAGINEGENIE_E2E_MOCK";
  w.__e2e__ = {
    seed: e2eSeed,
    reset: e2eReset,
    setDegraded: (reason: string | null) => {
      degradedReason = reason ?? "";
      persist();
    },
    markUnreadable: (ids: string[]) => {
      for (const id of ids) {
        const r = records.get(id) ?? (references.get(id) as unknown as StoredRecord | undefined);
        if (r) r.imageEnc = corruptPayload(r.imageEnc);
      }
      persist();
      broadcastLibChanged();
    },
    failNext: (op: "save" | "delete" | "clear") => {
      failNextOp = op;
    },
  } satisfies E2eControl;
}
