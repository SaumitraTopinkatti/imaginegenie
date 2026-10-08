/**
 * Encrypted browser-only storage.
 * - Images NEVER touch the filesystem; they live in IndexedDB, AES-GCM encrypted.
 * - A random 256-bit key is created on first run and kept in a separate
 *   IndexedDB store (`meta`). Payloads in `records` are unreadable without it.
 * - Falls back to XOR + base64 obfuscation only if WebCrypto is unavailable.
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

const DB_NAME = "imaginegenie";
const DB_VERSION = 1;
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
  });
}

function idbClear(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Clear failed."));
  });
}

export async function initCrypto(): Promise<"AES-GCM-256" | "XOR"> {
  if (cryptoKey || useXor) return useXor ? "XOR" : "AES-GCM-256";
  if (!hasSubtle()) {
    useXor = true;
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
      await idbPut(d, "meta", { key: "aes-key", b64: bufToB64(raw) });
      // First-run race: another tab may have generated + stored its own key
      // concurrently (last-write-wins). Never encrypt with an unconfirmed
      // orphan key — re-read and adopt whatever is actually stored.
      const winner = (await idbGet(d, "meta", "aes-key")) as
        | { key: string; b64: string }
        | undefined;
      const winnerRaw = b64ToBytes(winner?.b64 || bufToB64(raw));
      cryptoKey = await window.crypto.subtle.importKey(
        "raw",
        winnerRaw,
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"]
      );
    }
    d.close();
    return "AES-GCM-256";
  } catch {
    try {
      (await db).close();
    } catch {
      /* noop */
    }
    useXor = true;
    cryptoKey = null;
    return "XOR";
  }
}

export function cryptoMode(): string {
  return useXor ? "XOR" : "AES-GCM-256";
}

export async function encryptText(plain: string): Promise<EncryptedPayload> {
  if (useXor || !cryptoKey) return { iv: "xor", data: xorCrypt(plain), alg: "XOR" };
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const plainBuf = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
  const data = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plainBuf);
  return { iv: bufToB64(iv), data: bufToB64(data), alg: "AES-GCM-256" };
}

export async function decryptText(p: EncryptedPayload): Promise<string> {
  if (p.alg === "XOR" || p.iv === "xor") return xorDecrypt(p.data);
  if (!cryptoKey) throw new Error("Encryption key not ready.");
  const plain = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(p.iv) },
    cryptoKey,
    b64ToBytes(p.data)
  );
  return new TextDecoder().decode(plain);
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

export async function exportBackup(): Promise<string> {
  const records = await listRawRecords();
  return JSON.stringify(
    { app: "imaginegenie", version: 1, exportedAt: new Date().toISOString(), records },
    null,
    2
  );
}

export async function importBackup(json: string): Promise<number> {  const parsed = JSON.parse(json) as { app?: string; records?: StoredRecord[] };
  if (!parsed || !Array.isArray(parsed.records)) throw new Error("Not a valid backup file.");
  const db = await openDb();
  try {
    let n = 0;
    for (const r of parsed.records) {
      if (!r || typeof r.id !== "string" || !r.imageEnc) continue;
      await idbPut(db, "records", r);
      n++;
    }
    return n;
  } finally {
    db.close();
  }
}

/**
 * Count valid records in a backup payload without importing.
 * Throws on invalid payloads (same validation as importBackup).
 */
export function countBackupRecords(json: string): number {
  const parsed = JSON.parse(json) as { app?: string; records?: StoredRecord[] };
  if (!parsed || !Array.isArray(parsed.records)) throw new Error("Not a valid backup file.");
  return parsed.records.filter((r) => r && typeof r.id === "string" && !!r.imageEnc).length;
}

const LIB_CHANNEL = "imaginegenie-lib";

/**
 * Notify other tabs that the library changed (save/delete/clear/import).
 * Silent no-op where BroadcastChannel is unsupported.
 */
export function broadcastLibChanged(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(LIB_CHANNEL);
    ch.postMessage({ type: "imaginegenie-lib-changed", at: Date.now() });
    ch.close();
  } catch {
    /* unsupported — skip silently */
  }
}

/**
 * Subscribe to library changes from other tabs. Returns an unsubscribe fn.
 * Silent no-op (immediately-returned noop) where unsupported.
 */
export function subscribeLibChanged(cb: () => void): () => void {
  try {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    const ch = new BroadcastChannel(LIB_CHANNEL);
    ch.onmessage = () => cb();
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
