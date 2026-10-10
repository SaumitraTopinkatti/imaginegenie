/**
 * Encrypted browser-only storage.
 * - Images NEVER touch the filesystem; they live in IndexedDB, AES-GCM encrypted.
 * - A random 256-bit key is created on first run and kept in a separate
 *   IndexedDB store (`meta`). Payloads in `records` are unreadable without it.
 * - Writes refuse (throw) when AES is unavailable — there is no silent
 *   fallback. Old XOR-obfuscated rows stay readable, never writable.
 * - Backups wrap the device key with a passphrase (PBKDF2 + AES-GCM) so they
 *   restore on any browser with the passphrase.
 */

export interface EncryptedPayload {
  iv: string;
  data: string;
  alg: "AES-GCM-256" | "XOR";
}

export interface StoredRecord {
  id: string;
  createdAt: number;
  prompt: string;
  aspectRatio: string;
  resolution: string;
  cost: number;
  mediaType: string;
  refCount: number;
  seed?: number;
  imageEnc: EncryptedPayload;
  thumbEnc: EncryptedPayload;
  refsEnc?: EncryptedPayload[];
}

/**
 * A saved reference image. Deliberately NOT linked to generations: a
 * generation stores its own copy of the refs it used, so deleting a
 * reference never touches anything already generated.
 */
export interface StoredReference {
  id: string;
  createdAt: number;
  name: string;
  description: string;
  group: string;
  imageEnc: EncryptedPayload;
  thumbEnc: EncryptedPayload;
}

const DB_NAME = "imaginegenie";
const DB_VERSION = 2;
const XOR_SECRET = "imaginegenie-studio-v1::genie-lamp";

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function xorCrypt(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(
      String.fromCharCode(text.charCodeAt(i) ^ XOR_SECRET.charCodeAt(i % XOR_SECRET.length))
    );
  }
  return btoa(out.join(""));
}

function xorDecrypt(b64: string): string {
  const s = atob(b64);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push(String.fromCharCode(s.charCodeAt(i) ^ XOR_SECRET.charCodeAt(i % XOR_SECRET.length)));
  }
  return out.join("");
}

function hasSubtle(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.crypto?.subtle &&
    typeof window.crypto.subtle.generateKey === "function"
  );
}

let cryptoKey: CryptoKey | null = null;
let useXor = false;
/** Human-readable reason when initCrypto could not provide AES ("" = healthy). */
let degradedReason = "";
/** In-flight init shared by concurrent callers (StrictMode, two tabs). */
let initPromise: Promise<"AES-GCM-256" | "XOR"> | null = null;

export function initCrypto(): Promise<"AES-GCM-256" | "XOR"> {
  if (initPromise) return initPromise;
  initPromise = runInitCrypto();
  return initPromise;
}

/** Non-empty when the library runs degraded (no AES key): banner + write-block. */
export function cryptoDegraded(): string {
  return degradedReason;
}

async function runInitCrypto(): Promise<"AES-GCM-256" | "XOR"> {
  if (cryptoKey) return "AES-GCM-256";
  if (useXor) return "XOR";
  if (!hasSubtle()) {
    useXor = true;
    degradedReason = "WebCrypto is unavailable in this browser.";
    return "XOR";
  }
  const db = openDb();
  try {
    const d = await db;
    const existing = (await idbGet(d, "meta", "aes-key")) as { key: string; b64: string } | undefined;
    if (existing?.b64) {
      const raw = b64ToBytes(existing.b64);
      cryptoKey = await window.crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
        "encrypt",
        "decrypt",
      ]);
    } else {
      const fresh = await window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );
      const raw = await window.crypto.subtle.exportKey("raw", fresh);
      try {
        // add() (not put): concurrent first-runs in two tabs race here and
        // exactly one wins. The loser re-reads and adopts the winner instead
        // of encrypting under an orphan key that is never reloadable.
        await idbAdd(d, "meta", { key: "aes-key", b64: bufToB64(raw) });
        cryptoKey = fresh;
      } catch (e) {
        if ((e as DOMException)?.name !== "ConstraintError") throw e;
        const winner = (await idbGet(d, "meta", "aes-key")) as
          | { key: string; b64: string }
          | undefined;
        if (!winner?.b64) throw new Error("Could not read the device key.");
        const winnerRaw = b64ToBytes(winner.b64);
        cryptoKey = await window.crypto.subtle.importKey(
          "raw",
          winnerRaw,
          { name: "AES-GCM" },
          true,
          ["encrypt", "decrypt"]
        );
      }
    }
    d.close();
    return "AES-GCM-256";
  } catch (e) {
    try {
      (await db).close();
    } catch {
      /* noop */
    }
    useXor = true;
    cryptoKey = null;
    degradedReason = e instanceof Error ? e.message : "Could not start encryption.";
    return "XOR";
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) {
        db.createObjectStore("records", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("references")) {
        db.createObjectStore("references", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open local database."));
  });
}

function idbGet(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Read failed."));
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Write failed."));
    // Quota failures abort the transaction (often without an error event);
    // without this the promise never settles and the UI hangs forever.
    tx.onabort = () => reject(tx.error || new Error("Write failed."));
  });
}

function idbAdd(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).add(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || tx.error || new Error("Write failed."));
    tx.onabort = () => reject(tx.error || req.error || new Error("Write failed."));
  });
}

function idbGetAll(db: IDBDatabase, store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result as unknown[]) || []);
    req.onerror = () => reject(req.error || new Error("Read failed."));
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Delete failed."));
    tx.onabort = () => reject(tx.error || new Error("Delete failed."));
  });
}

function idbClear(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Clear failed."));
    tx.onabort = () => reject(tx.error || new Error("Clear failed."));
  });
}

/** Multi-store write in one transaction: all or nothing (used by import). */
function idbPutMany(db: IDBDatabase, puts: Array<{ store: string; value: unknown }>): Promise<void> {
  if (puts.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stores = [...new Set(puts.map((p) => p.store))];
    const tx = db.transaction(stores, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Import failed."));
    tx.onabort = () => reject(tx.error || new Error("Import failed."));
    for (const p of puts) tx.objectStore(p.store).put(p.value);
  });
}

export function cryptoMode(): string {
  return useXor ? "XOR" : "AES-GCM-256";
}

/**
 * Opt-in remembered API key. Stored as an encrypted payload in `meta` under
 * "openrouter-key", so it survives restarts but is unreadable without the
 * device library key. Same-origin JS can still use it — this protects the
 * key at rest on a shared device, nothing more.
 */
const API_KEY_META = "openrouter-key";

export async function saveApiKeyPayload(p: EncryptedPayload): Promise<void> {
  const db = await openDb();
  try {
    await idbPut(db, "meta", { key: API_KEY_META, iv: p.iv, data: p.data, alg: p.alg });
  } finally {
    db.close();
  }
}

export async function loadApiKeyPayload(): Promise<EncryptedPayload | null> {
  const db = await openDb();
  try {
    const row = (await idbGet(db, "meta", API_KEY_META)) as
      | (EncryptedPayload & { key: string })
      | undefined;
    if (!row || !row.data || (row.alg !== "AES-GCM-256" && row.alg !== "XOR")) return null;
    return { iv: row.iv, data: row.data, alg: row.alg };
  } finally {
    db.close();
  }
}

export async function clearApiKeyPayload(): Promise<void> {
  const db = await openDb();
  try {
    await idbDelete(db, "meta", API_KEY_META);
  } finally {
    db.close();
  }
}

async function encryptWith(key: CryptoKey, plain: string): Promise<EncryptedPayload> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const plainBuf = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
  const data = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuf);
  return { iv: bufToB64(iv), data: bufToB64(data), alg: "AES-GCM-256" };
}

async function decryptWith(key: CryptoKey, p: EncryptedPayload): Promise<string> {
  const plain = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(p.iv) },
    key,
    b64ToBytes(p.data)
  );
  return new TextDecoder().decode(plain);
}

/**
 * Raw device key for passphrase-wrapping (backup export). Throws degraded —
 * a backup without AES is unrestorable anywhere else, so refuse loudly.
 */
export async function getDeviceKeyRaw(): Promise<Uint8Array<ArrayBuffer>> {
  if (!cryptoKey) throw new Error("Encryption unavailable — backup needs AES-GCM.");
  const raw = await window.crypto.subtle.exportKey("raw", cryptoKey);
  return new Uint8Array(raw);
}

export async function encryptText(plain: string): Promise<EncryptedPayload> {
  // Never fall back to XOR: it is a bundle-constant obfuscation, and writing
  // new rows with it would silently downgrade the whole library. Callers
  // (generate, remember-key, backup) must refuse when this throws.
  if (!cryptoKey) throw new Error("Encryption unavailable — new data cannot be saved.");
  return encryptWith(cryptoKey, plain);
}

export async function decryptText(p: EncryptedPayload): Promise<string> {
  // XOR rows from older/degraded sessions stay readable; only WRITES refuse.
  if (p.alg === "XOR" || p.iv === "xor") return xorDecrypt(p.data);
  if (!cryptoKey) throw new Error("Encryption key not ready.");
  return decryptWith(cryptoKey, p);
}

export async function saveRecord(r: StoredRecord): Promise<void> {
  const db = await openDb();
  try {
    await idbPut(db, "records", r);
  } finally {
    db.close();
  }
}

export async function listRawRecords(): Promise<StoredRecord[]> {
  const db = await openDb();
  try {
    const all = (await idbGetAll(db, "records")) as StoredRecord[];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await openDb();
  try {
    await idbDelete(db, "records", id);
  } finally {
    db.close();
  }
}

export async function clearRecords(): Promise<void> {
  const db = await openDb();
  try {
    await idbClear(db, "records");
  } finally {
    db.close();
  }
}

/* ---------- reference library (standalone; never linked to generations) ---------- */

export interface DecryptedReference {
  imageUrl: string;
  thumbUrl: string;
}

export async function saveReference(r: StoredReference): Promise<void> {
  const db = await openDb();
  try {
    await idbPut(db, "references", r);
  } finally {
    db.close();
  }
}

export async function listRawReferences(): Promise<StoredReference[]> {
  const db = await openDb();
  try {
    const all = (await idbGetAll(db, "references")) as StoredReference[];
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function deleteReference(id: string): Promise<void> {
  const db = await openDb();
  try {
    await idbDelete(db, "references", id);
  } finally {
    db.close();
  }
}

export async function clearReferences(): Promise<void> {
  const db = await openDb();
  try {
    await idbClear(db, "references");
  } finally {
    db.close();
  }
}

/** Decrypt a stored reference. A corrupt thumbnail falls back to the full image. */
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

/* ---------- portable backups: device key wrapped by a passphrase ---------- */

export const BACKUP_MIN_PASSPHRASE = 8;
const BACKUP_PBKDF2_ITERATIONS = 600_000;

/** Device AES key wrapped with a passphrase-derived key (AES-GCM). */
export interface BackupKeyWrap {
  salt: string;
  iterations: number;
  iv: string;
  wrappedKey: string;
}

export interface BackupFile {
  app: "imaginegenie";
  schemaVersion: 2;
  version: 1;
  exportedAt: string;
  records: StoredRecord[];
  references: StoredReference[];
  keyWrap?: BackupKeyWrap;
}

async function deriveWrapKey(pass: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function wrapDeviceKey(pass: string): Promise<BackupKeyWrap> {
  if (pass.length < BACKUP_MIN_PASSPHRASE) {
    throw new Error(`Passphrase must be at least ${BACKUP_MIN_PASSPHRASE} characters.`);
  }
  const raw = await getDeviceKeyRaw();
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const wk = await deriveWrapKey(pass, salt, BACKUP_PBKDF2_ITERATIONS);
  const wrapped = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, wk, raw);
  return {
    salt: bufToB64(salt),
    iterations: BACKUP_PBKDF2_ITERATIONS,
    iv: bufToB64(iv),
    wrappedKey: bufToB64(wrapped),
  };
}

async function unwrapDeviceKey(pass: string, w: BackupKeyWrap): Promise<CryptoKey> {
  const wk = await deriveWrapKey(pass, b64ToBytes(w.salt), w.iterations);
  const raw = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(w.iv) },
    wk,
    b64ToBytes(w.wrappedKey)
  );
  return window.crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

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

interface ParsedBackup {
  records: StoredRecord[];
  references: StoredReference[];
  keyWrap?: BackupKeyWrap;
}

/** Validate app/version/shape. Throws on anything that isn't our backup. */
function parseBackupFile(jsonText: string): ParsedBackup {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(jsonText) as BackupFile;
  } catch {
    throw new Error("Not a valid backup file.");
  }
  if (!parsed || parsed.app !== "imaginegenie" || !Array.isArray(parsed.records)) {
    throw new Error("Not a valid backup file.");
  }
  const references = Array.isArray(parsed.references) ? parsed.references : [];
  let keyWrap: BackupKeyWrap | undefined;
  if (parsed.keyWrap !== undefined) {
    if (!validWrap(parsed.keyWrap)) throw new Error("Not a valid backup file.");
    keyWrap = parsed.keyWrap;
  }
  return {
    records: parsed.records.filter(validRecord),
    references: references.filter(validReference),
    keyWrap,
  };
}

/** Header info for the restore dialog (counts + whether a passphrase is needed). */
export function peekBackup(jsonText: string): { records: number; references: number; hasKeyWrap: boolean } {
  const p = parseBackupFile(jsonText);
  return { records: p.records.length, references: p.references.length, hasKeyWrap: !!p.keyWrap };
}

export async function exportBackup(passphrase: string): Promise<string> {
  // Throws degraded (no AES key) or on a short passphrase — never writes an
  // unrestorable file.
  const keyWrap = await wrapDeviceKey(passphrase);
  const records = await listRawRecords();
  const references = await listRawReferences();
  const file: BackupFile = {
    app: "imaginegenie",
    schemaVersion: 2,
    version: 1,
    exportedAt: new Date().toISOString(),
    records,
    references,
    keyWrap,
  };
  return JSON.stringify(file);
}

/** Imported totals: generations plus references. Throws on invalid payloads. */
export interface ImportCounts {
  records: number;
  references: number;
}

export interface ImportResult extends ImportCounts {
  /** Items in the file that could not be decrypted (skipped, never stored). */
  unreadable: number;
  /** True for pre-passphrase backups: restorable only where made. */
  legacy: boolean;
}

export async function importBackup(jsonText: string, passphrase = ""): Promise<ImportResult> {
  const parsed = parseBackupFile(jsonText);
  const total = parsed.records.length + parsed.references.length;
  if (total === 0) return { records: 0, references: 0, unreadable: 0, legacy: !parsed.keyWrap };

  const db = await openDb();
  try {
    if (parsed.keyWrap) {
      if (!passphrase) throw new Error("This backup needs its passphrase — nothing imported.");
      let backupKey: CryptoKey;
      try {
        backupKey = await unwrapDeviceKey(passphrase, parsed.keyWrap);
      } catch {
        throw new Error("Wrong passphrase or corrupt backup — nothing imported.");
      }
      // Trial-decrypt the first payload BEFORE writing anything.
      try {
        const first = parsed.records[0] ?? parsed.references[0];
        if (first) await decryptWith(backupKey, first.imageEnc);
      } catch {
        throw new Error("Wrong passphrase or corrupt backup — nothing imported.");
      }
      // Re-encrypt everything under the local device key so the rows are
      // readable here even when the backup came from another browser.
      // encryptText throws degraded — a broken-crypto device cannot import.
      const puts: Array<{ store: string; value: unknown }> = [];
      let unreadable = 0;
      for (const r of parsed.records) {
        try {
          const imageUrl = await decryptWith(backupKey, r.imageEnc);
          let thumbUrl = imageUrl;
          try {
            thumbUrl = await decryptWith(backupKey, r.thumbEnc);
          } catch {
            thumbUrl = imageUrl;
          }
          const refsEnc: EncryptedPayload[] = [];
          if (Array.isArray(r.refsEnc)) {
            for (const p of r.refsEnc) {
              try {
                refsEnc.push(await encryptText(await decryptWith(backupKey, p)));
              } catch {
                /* skip one corrupt ref */
              }
            }
          }
          puts.push({
            store: "records",
            value: {
              ...r,
              imageEnc: await encryptText(imageUrl),
              thumbEnc: await encryptText(thumbUrl),
              refsEnc,
            },
          });
        } catch {
          unreadable += 1;
        }
      }
      let rn = 0;
      const refPuts: Array<{ store: string; value: unknown }> = [];
      for (const r of parsed.references) {
        try {
          const imageUrl = await decryptWith(backupKey, r.imageEnc);
          let thumbUrl = imageUrl;
          try {
            thumbUrl = await decryptWith(backupKey, r.thumbEnc);
          } catch {
            thumbUrl = imageUrl;
          }
          refPuts.push({
            store: "references",
            value: {
              ...r,
              imageEnc: await encryptText(imageUrl),
              thumbEnc: await encryptText(thumbUrl),
            },
          });
          rn += 1;
        } catch {
          unreadable += 1;
        }
      }
      const n = puts.length;
      // Single transaction: all or nothing, never a partial import.
      await idbPutMany(db, [...puts, ...refPuts]);
      return { records: n, references: rn, unreadable, legacy: false };
    }
    // Legacy backup (no wrapped key): only rows decryptable with the LOCAL
    // key are imported; anything else is reported, never stored silently.
    const goodRecords = [];
    const goodRefs = [];
    for (const r of parsed.records) {
      try {
        await decryptRecordLocal(r);
        goodRecords.push(r);
      } catch {
        /* counted below */
      }
    }
    for (const r of parsed.references) {
      try {
        await decryptReferenceLocal(r);
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
    await idbPutMany(db, [
      ...goodRecords.map((value) => ({ store: "records", value })),
      ...goodRefs.map((value) => ({ store: "references", value })),
    ]);
    return { records: goodRecords.length, references: goodRefs.length, unreadable, legacy: true };
  } finally {
    db.close();
  }
}

/** Trial-decrypt helpers used by legacy import (local key, image must read). */
async function decryptRecordLocal(r: StoredRecord): Promise<void> {
  await decryptText(r.imageEnc);
}

async function decryptReferenceLocal(r: StoredReference): Promise<void> {
  await decryptText(r.imageEnc);
}

/**
 * Count valid records in a backup payload without importing.
 * Throws on invalid payloads (same validation as importBackup).
 */
export function countBackupRecords(json: string): number {
  const p = parseBackupFile(json);
  return p.records.length + p.references.length;
}

export function countBackupReferences(json: string): number {
  return parseBackupFile(json).references.length;
}

const LIB_CHANNEL = "imaginegenie-lib";
/** Identifies this tab so a tab never reloads in response to its own broadcast. */
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Notify other tabs that the library changed (save/delete/clear/import).
 * Silent no-op where BroadcastChannel is unsupported.
 */
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

/**
 * Subscribe to library changes from other tabs. Returns an unsubscribe fn.
 * Messages posted by this tab are ignored (BroadcastChannel delivers to every
 * other channel object in the same context, including same-page ones).
 * Silent no-op (immediately-returned noop) where unsupported.
 */
export function subscribeLibChanged(cb: () => void): () => void {
  try {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    const ch = new BroadcastChannel(LIB_CHANNEL);
    ch.onmessage = (e) => {
      if (e?.data?.tabId === TAB_ID) return;
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

export interface DecryptedRecord {
  imageUrl: string;
  thumbUrl: string;
  refUrls: string[];
}

/**
 * Decrypt a stored record. A corrupt thumbnail falls back to the full image
 * and corrupt refs are skipped individually; only a failed image throws.
 * Records saved before refs existed simply yield an empty ref list.
 */
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

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
