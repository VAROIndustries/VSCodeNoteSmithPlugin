// node test.js — builds a vault the way the NoteSmith web app does, then reads/writes it.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Vault, deriveKek, encryptJson } = require("./vault");
const md = require("./markdown");
const { subtle } = globalThis.crypto;

const b64 = (u8) => Buffer.from(u8).toString("base64");
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function wrap(dek, secret, iters) {
  const salt = rand(16), iv = rand(12);
  const data = await subtle.wrapKey("raw", dek, await deriveKek(secret, salt, iters), { name: "AES-GCM", iv });
  return [{ salt: b64(salt), iters }, { iv: b64(iv), data: b64(new Uint8Array(data)) }];
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsvault-"));
  const dek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const [kdf, wrapped] = await wrap(dek, "daily pass", 1000);
  const [backupKdf, wrappedBackup] = await wrap(dek, "BACKUP-CODE", 1000);
  fs.writeFileSync(path.join(dir, "vault.json"), JSON.stringify({ v: 1, kdf, wrapped, backupKdf, wrappedBackup }));

  const entry = { id: "doc-1", kind: "doc", vaultFolderId: "F1", parentId: null, title: "Plan", updatedAt: "2026-01-01T00:00:00Z", coverBlobId: "keep-me" };
  const sub = { ...entry, id: "doc-2", parentId: "doc-1", title: "Sub" };
  const content = md.markdownToTiptapJson("# Hi\n\nSome **bold** and `code` and [a link](https://x.io).\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x = 1;\n```");
  fs.writeFileSync(path.join(dir, "index.enc"), await encryptJson({ v: 1, entries: [entry, sub], blobs: {} }, dek));
  fs.writeFileSync(path.join(dir, "doc-1.enc"), await encryptJson({ ...entry, content }, dek));
  fs.writeFileSync(path.join(dir, "doc-2.enc"), await encryptJson({ ...entry, content }, dek)); // wrong id inside

  await assert.rejects(Vault.unlock(dir, "nope"), /Wrong passphrase/);
  await Vault.unlock(dir, "BACKUP-CODE"); // backup code opens it too
  const v = await Vault.unlock(dir, "daily pass");

  assert.deepStrictEqual(await v.roots(), ["F1"]);
  assert.deepStrictEqual((await v.children("F1", null)).map((e) => e.id), ["doc-1"]);
  assert.deepStrictEqual((await v.children("F1", "doc-1")).map((e) => e.id), ["doc-2"]);
  await assert.rejects(v.loadDoc("doc-2"), /does not match/);

  // Markdown round trip is a fixed point for safe content
  const text = md.tiptapToMarkdown(await v.loadDoc("doc-1"));
  assert.strictEqual(md.tiptapToMarkdown(md.markdownToTiptapJson(text)), text);
  assert.deepStrictEqual(md.unsafeTypes(content), []);

  // Save: doc file rewritten, index entry updated, unknown fields kept
  await v.saveDoc(await v.entry("doc-1"), md.markdownToTiptapJson(text + "\n\nAdded line."));
  assert.match(md.tiptapToMarkdown(await v.loadDoc("doc-1")), /Added line\.$/);
  const e = await v.entry("doc-1");
  assert.strictEqual(e.coverBlobId, "keep-me");
  assert.notStrictEqual(e.updatedAt, entry.updatedAt);
  assert.strictEqual((await v.index()).entries.length, 2);

  // Content Markdown can't carry is flagged, so the editor opens it read-only
  const tasks = { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "highlight" }] }] }] }] }] };
  assert.deepStrictEqual(md.unsafeTypes(tasks).sort(), ["highlight", "taskItem", "taskList"]);
  assert.deepStrictEqual(md.unsafeMarkdown("- [x] done\n\n![img](a.png)"), ["image", "taskList"]);
  assert.deepStrictEqual(md.unsafeMarkdown("- plain list\n\n[link](a)"), []);

  // bold+code must not grow asterisks on each round trip (server converter bug)
  assert.ok(md.roundTrips("**Push to `master` now.** Then **`deploy.sh`** runs."));
  assert.ok(md.roundTrips("Intro\n\n---\n\nKeep me\n\n---\n\nEnd")); // two rules aren't frontmatter
  assert.ok(md.roundTrips("1. **Item.** text\n   - nested\n2. Next")); // ordered sub-list stays nested

  // MCP bridge over real HTTP: guards first, then the JSON-RPC flow
  const mcp = require("./mcp");
  const notes = {
    list: async () => [{ id: "doc-1" }],
    read: async (id) => { if (id !== "doc-1") throw new Error("No note"); return { markdown: "x" }; },
    write: async (a) => ({ id: a.id ?? "new", wrote: a.markdown }),
  };
  const srv = await mcp.serve(0, "tok", notes);
  const port = srv.address().port;
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const call = async (id, name, args) => JSON.parse((await (await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).json()).result.content[0].text);
  assert.strictEqual((await post({}, { Authorization: "Bearer nope" })).status, 401);
  assert.strictEqual((await post({}, { Origin: "https://evil.example" })).status, 403);
  // fetch() won't let us forge Host; the server's Host check is exercised by http.request
  const forged = await new Promise((r) => require("http").request({ port, host: "127.0.0.1", method: "POST", path: "/mcp",
    headers: { Host: "evil.example", Authorization: "Bearer tok" } }, (res) => r(res.statusCode)).end("{}"));
  assert.strictEqual(forged, 403);
  const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  assert.strictEqual(init.result.serverInfo.name, "notesmith-vault");
  assert.strictEqual((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepStrictEqual(tools.result.tools.map((t) => t.name), ["list_notes", "read_note", "write_note"]);
  assert.deepStrictEqual(await call(3, "list_notes", {}), [{ id: "doc-1" }]);
  assert.deepStrictEqual(await call(4, "write_note", { title: "T", markdown: "# hi" }), { id: "new", wrote: "# hi" });
  const missing = await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_note", arguments: { id: "zzz" } } })).json();
  assert.strictEqual(missing.result.isError, true);
  srv.close();

  fs.rmSync(dir, { recursive: true });
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
