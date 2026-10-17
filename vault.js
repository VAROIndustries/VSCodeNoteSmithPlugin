// NoteSmith local-only vault, read/written from disk. Ported 2026-10-17 from NoteSmith
// apps/web/src/lib/vault/{crypto,format,index-model}.ts + components/vault/VaultProvider.tsx.
// Same format the web app writes: vault.json (PBKDF2-wrapped DEK, twice), index.enc,
// one <entryId>.enc per note. Every .enc is iv(12) || AES-256-GCM ciphertext of JSON.
//
// ponytail: index.enc is re-read before every write, but the web app keeps its index in
// memory and doesn't — editing the same vault in the browser and VS Code at the same time
// is last-writer-wins on the index. A lock file would need the web app's cooperation.
const fs = require("fs/promises");
const path = require("path");
const { subtle } = globalThis.crypto;

const VAULT_FILE = "vault.json";
const INDEX_FILE = "index.enc";
const IV_BYTES = 12;

const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function deriveKek(secret, salt, iters) {
  const material = await subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"],
  );
}

async function unwrapDek(w, kek) {
  return subtle.unwrapKey("raw", b64(w.data), kek, { name: "AES-GCM", iv: b64(w.iv) },
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptJson(value, dek) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(JSON.stringify(value))));
  return Buffer.concat([iv, cipher]);
}

async function decryptJson(bytes, dek) {
  if (bytes.length <= IV_BYTES) throw new Error("Vault file is truncated");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) }, dek, bytes.subarray(IV_BYTES));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function readOrNull(file) {
  try { return await fs.readFile(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

class Vault {
  constructor(dir, dek) { this.dir = dir; this.dek = dek; }

  /** Throws "Wrong passphrase or backup code" when neither wrapper opens. */
  static async unlock(dir, secret) {
    const raw = await readOrNull(path.join(dir, VAULT_FILE));
    if (!raw) throw new Error(`No NoteSmith vault (vault.json) in ${dir}`);
    const f = JSON.parse(raw.toString("utf8"));
    if (f.v !== 1 || !f.kdf || !f.wrapped || !f.backupKdf || !f.wrappedBackup) throw new Error("Unsupported vault.json format");
    let dek;
    try {
      // The file's own iteration count, never a constant — see crypto.ts deriveKek.
      dek = await unwrapDek(f.wrapped, await deriveKek(secret, b64(f.kdf.salt), f.kdf.iters));
    } catch {
      try {
        dek = await unwrapDek(f.wrappedBackup, await deriveKek(secret, b64(f.backupKdf.salt), f.backupKdf.iters));
      } catch {
        throw new Error("Wrong passphrase or backup code");
      }
    }
    const v = new Vault(dir, dek);
    await v.index(); // fail now, not on first click, if index.enc is corrupt
    return v;
  }

  async index() {
    const bytes = await readOrNull(path.join(this.dir, INDEX_FILE));
    return bytes ? decryptJson(bytes, this.dek) : { v: 1, entries: [], blobs: {} };
  }

  /** Distinct vault roots (DB Folder ids) that have entries in this vault. */
  async roots() {
    return [...new Set((await this.index()).entries.map((e) => e.vaultFolderId))];
  }

  async children(vaultFolderId, parentId) {
    return (await this.index()).entries
      .filter((e) => e.vaultFolderId === vaultFolderId && (e.parentId ?? null) === (parentId ?? null))
      .sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "folder" ? -1 : 1));
  }

  async entry(id) {
    return (await this.index()).entries.find((e) => e.id === id) ?? null;
  }

  async loadDoc(id) {
    const bytes = await readOrNull(path.join(this.dir, `${id}.enc`));
    if (!bytes) return null;
    const payload = await decryptJson(bytes, this.dek);
    // GCM authenticates the bytes, not which file they belong in — a swapped A.enc/B.enc
    // would decrypt cleanly. The id inside the ciphertext is the binding.
    if (payload.id !== id) throw new Error("Vault file does not match the requested note — refusing to load it");
    return payload.content;
  }

  /** Doc file first, index second — a crash between leaves an orphan, never a lost note. */
  async saveDoc(entry, content) {
    const next = { ...entry, updatedAt: new Date().toISOString() };
    await fs.writeFile(path.join(this.dir, `${next.id}.enc`), await encryptJson({ ...next, content }, this.dek));
    const ix = await this.index(); // fresh read: the browser may have written since we last looked
    const i = ix.entries.findIndex((e) => e.id === next.id);
    if (i >= 0) ix.entries[i] = { ...ix.entries[i], ...next }; // keep fields we don't know (coverBlobId, restoredDocId…)
    else ix.entries.push(next);
    await fs.writeFile(path.join(this.dir, INDEX_FILE), await encryptJson(ix, this.dek));
    return next;
  }
}

module.exports = { Vault, deriveKek, encryptJson, decryptJson };
