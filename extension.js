const vscode = require("vscode");
const crypto = require("crypto");
const { Vault } = require("./vault");
const md = require("./markdown");
const mcp = require("./mcp");

const SECRET_KEY = "notesmith.apiKey";
const MCP_TOKEN = "notesmith.mcpToken";
const VAULT_DIR = "notesmith.vaultDir"; // workspaceState: a disk path is machine-specific, so not a shared setting
const enc = new TextEncoder();
const dec = new TextDecoder();

let ctx;
let vault = null; // unlocked Vault; the DEK lives only in memory, for this window
let mcpServer = null;
const mcpDefsChanged = new vscode.EventEmitter(); // tells VS Code (Copilot) the bridge came or went
const fileChanged = new vscode.EventEmitter();
const cache = new Map(); // uri -> { text, readonly, mtime, at }
const warned = new Set(); // uris already told they're read-only
const tree = { onDidChange: new vscode.EventEmitter() };

const cfg = () => vscode.workspace.getConfiguration("notesmith");
const apiBase = () => (cfg().get("apiBase") || "https://notesmith.io").replace(/\/+$/, "");

async function api(path, opts = {}) {
  const key = await ctx.secrets.get(SECRET_KEY);
  if (!key) throw new Error("No NoteSmith API key — run “NoteSmith: Set API Key”.");
  const res = await fetch(apiBase() + "/api/v1" + path, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`NoteSmith ${res.status}: ${data.error || res.statusText}`);
  return data;
}

async function allDocs(workspaceId, folderId) {
  const out = [];
  for (let offset = 0; ; ) {
    const r = await api(`/docs?workspaceId=${workspaceId}&folderId=${folderId}&limit=100&offset=${offset}`);
    out.push(...r.docs);
    offset += r.docs.length;
    if (!r.docs.length || offset >= r.total) return out;
  }
}

// ------------------------------------------------------------------ URIs
// notesmith:/<docId>/<title>.md and notesmith-vault:/<entryId>/<title>.md — the title is
// only there so the editor tab reads well; the id is what's used.
const fileName = (title) => (title || "Untitled").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) + ".md";
const docUri = (scheme, id, title) => vscode.Uri.from({ scheme, path: `/${id}/${fileName(title)}` });
const idOf = (uri) => uri.path.split("/")[1];

// ------------------------------------------------------------------ File system
async function load(uri) {
  const id = idOf(uri);
  let text, readonly, why, mtime;
  if (uri.scheme === "notesmith") {
    const d = await api(`/docs/${id}`);
    text = d.content ?? "";
    why = md.unsafeMarkdown(text);
    if (!why.length && !md.roundTrips(text)) why = ["formatting"];
    mtime = Date.parse(d.updatedAt);
  } else {
    if (!vault) throw vscode.FileSystemError.Unavailable("Vault is locked — run “NoteSmith: Unlock Vault”.");
    const n = await vaultNote(id);
    if (!n) throw vscode.FileSystemError.FileNotFound(uri);
    ({ text, why } = n);
    mtime = Date.parse(n.entry.updatedAt);
  }
  readonly = why.length > 0;
  if (readonly && !warned.has(uri.toString())) {
    warned.add(uri.toString());
    vscode.window.showInformationMessage(
      `This note has ${why.join(", ")} content that Markdown can't round-trip, so it's read-only here. Edit it in NoteSmith.`);
  }
  const c = { text, readonly, mtime: mtime || Date.now(), at: Date.now() };
  cache.set(uri.toString(), c);
  return c;
}

/** Vault note as Markdown, plus why it can't be written back safely (empty = writable). Shared by the editor and MCP. */
async function vaultNote(id) {
  const entry = await vault.entry(id);
  if (!entry) return null;
  const content = await vault.loadDoc(id);
  const text = content ? md.tiptapToMarkdown(content) : "";
  const why = content ? md.unsafeTypes(content) : [];
  if (!why.length && !md.roundTrips(text)) why.push("formatting");
  return { entry, text, why };
}

async function createVaultNote(parentId, title, content) {
  const entry = {
    id: crypto.randomUUID(), kind: "doc", vaultFolderId: cfg().get("vaultFolderId"),
    parentId: parentId ?? null, title, updatedAt: new Date().toISOString(),
  };
  return vault.saveDoc(entry, content);
}

const fsProvider = {
  onDidChangeFile: fileChanged.event,
  watch: () => new vscode.Disposable(() => {}),
  async stat(uri) {
    const c = cache.get(uri.toString()) ?? (await load(uri));
    return {
      type: vscode.FileType.File, ctime: c.mtime, mtime: c.mtime, size: enc.encode(c.text).length,
      permissions: c.readonly ? vscode.FilePermission.Readonly : undefined,
    };
  },
  async readFile(uri) {
    const c = cache.get(uri.toString());
    // stat() usually loaded it a moment ago; otherwise always fetch fresh.
    return enc.encode((c && Date.now() - c.at < 2000 ? c : await load(uri)).text);
  },
  async writeFile(uri, bytes) {
    const c = cache.get(uri.toString()) ?? (await load(uri));
    if (c.readonly) throw vscode.FileSystemError.NoPermissions("Read-only: this note has content Markdown can't round-trip.");
    const text = dec.decode(bytes);
    if (text === c.text) return; // nothing changed — don't rewrite (or bump updatedAt)
    const id = idOf(uri);
    if (uri.scheme === "notesmith") {
      const r = await api(`/docs/${id}`, { method: "PATCH", body: { content: text } });
      c.mtime = Date.parse(r.updatedAt) || Date.now();
    } else {
      if (!vault) throw vscode.FileSystemError.Unavailable("Vault is locked.");
      const e = await vault.entry(id);
      if (!e) throw vscode.FileSystemError.FileNotFound(uri);
      c.mtime = Date.parse((await vault.saveDoc(e, md.markdownToTiptapJson(text))).updatedAt);
    }
    c.text = text;
    tree.onDidChange.fire();
  },
  readDirectory: () => [],
  createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
  delete: () => { throw vscode.FileSystemError.NoPermissions("Delete notes in NoteSmith."); },
  rename: () => { throw vscode.FileSystemError.NoPermissions("Rename notes in NoteSmith."); },
};

// ------------------------------------------------------------------ Tree
// Node shapes: { kind: "server" | "vault" } group roots, { kind: "sfolder", id, name },
// { kind: "sdoc", id, title }, { kind: "ventry", entry }, { kind: "msg", label, command }.
const treeProvider = {
  onDidChangeTreeData: tree.onDidChange.event,

  getTreeItem(n) {
    const C = vscode.TreeItemCollapsibleState;
    if (n.kind === "msg") return Object.assign(new vscode.TreeItem(n.label), { command: n.command });
    if (n.kind === "server" || n.kind === "vault") {
      const t = new vscode.TreeItem(n.label, C.Expanded);
      t.iconPath = new vscode.ThemeIcon(n.kind === "vault" ? (vault ? "unlock" : "lock") : "cloud");
      t.contextValue = n.kind === "vault" ? (vault ? "vaultRoot" : "vaultLocked") : "serverRoot";
      return t;
    }
    if (n.kind === "sfolder") {
      return Object.assign(new vscode.TreeItem(n.name, C.Collapsed), { iconPath: vscode.ThemeIcon.Folder, contextValue: "serverFolder" });
    }
    if (n.kind === "sdoc") return docItem(docUri("notesmith", n.id, n.title), n.title, "serverDoc");
    const e = n.entry;
    if (e.kind === "folder") {
      return Object.assign(new vscode.TreeItem(e.title, C.Collapsed), { iconPath: vscode.ThemeIcon.Folder, contextValue: "vaultFolder" });
    }
    const t = docItem(docUri("notesmith-vault", e.id, e.title), e.title, "vaultDoc");
    if (n.hasKids) t.collapsibleState = C.Collapsed; // a vault note can own sub-notes
    return t;
  },

  async getChildren(n) {
    try {
      if (!n) return roots();
      if (n.kind === "server") return serverChildren(n.folderId);
      if (n.kind === "sfolder") return serverChildren(n.id);
      if (n.kind === "vault") {
        if (!vault) return [{ kind: "msg", label: "Locked — click to unlock", command: { command: "notesmith.unlockVault", title: "Unlock" } }];
        return vaultChildren(null);
      }
      if (n.kind === "ventry") return vaultChildren(n.entry.id);
      return [];
    } catch (err) {
      return [{ kind: "msg", label: `⚠ ${err.message}` }];
    }
  },
};

function docItem(uri, title, contextValue) {
  const t = new vscode.TreeItem(title || "Untitled");
  t.resourceUri = uri;
  t.iconPath = new vscode.ThemeIcon("note");
  t.contextValue = contextValue;
  t.command = { command: "vscode.open", title: "Open", arguments: [uri] };
  return t;
}

let folderCache = null; // { workspaceId, folders }
async function folders(workspaceId) {
  if (folderCache?.workspaceId !== workspaceId) folderCache = { workspaceId, folders: (await api(`/folders?workspaceId=${workspaceId}`)).folders };
  return folderCache.folders;
}

async function roots() {
  const out = [];
  const ws = cfg().get("workspaceId");
  const fid = cfg().get("folderId");
  if (ws && fid) {
    const f = (await folders(ws).catch(() => [])).find((x) => x.id === fid);
    out.push({ kind: "server", label: f?.name ?? "NoteSmith folder", folderId: fid });
  }
  if (cfg().get("vaultFolderId") && ctx.workspaceState.get(VAULT_DIR)) {
    out.push({ kind: "vault", label: cfg().get("vaultName") || "Vault" });
  }
  return out; // empty -> the viewsWelcome content in package.json shows instead
}

async function serverChildren(folderId) {
  const ws = cfg().get("workspaceId");
  const subs = (await folders(ws)).filter((f) => f.parentId === folderId).map((f) => ({ kind: "sfolder", id: f.id, name: f.name }));
  const docs = (await allDocs(ws, folderId)).map((d) => ({ kind: "sdoc", id: d.id, title: d.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return [...subs, ...docs];
}

async function vaultChildren(parentId) {
  const parents = new Set((await vault.index()).entries.map((e) => e.parentId));
  return (await vault.children(cfg().get("vaultFolderId"), parentId)).map((entry) => ({ kind: "ventry", entry, hasKids: parents.has(entry.id) }));
}

// ------------------------------------------------------------------ Commands
async function needWorkspace() {
  if (!vscode.workspace.workspaceFolders?.length) throw new Error("Open a folder or workspace first — the link is saved to its .vscode/settings.json.");
}
const save = (k, v) => cfg().update(k, v, vscode.ConfigurationTarget.Workspace);

async function pickWorkspace() {
  const { workspaces } = await api("/workspaces");
  if (workspaces.length === 1) return workspaces[0];
  const p = await vscode.window.showQuickPick(workspaces.map((w) => ({ label: w.name, w })), { placeHolder: "NoteSmith workspace" });
  return p?.w;
}

function folderPath(f, all) {
  const parts = [];
  for (let cur = f, guard = 0; cur && guard < 64; cur = all.find((x) => x.id === cur.parentId), guard++) parts.unshift(cur.name);
  return parts.join(" / ");
}

const commands = {
  async setApiKey() {
    const key = await vscode.window.showInputBox({
      prompt: "NoteSmith API key (Settings → API keys in NoteSmith). Stored in VS Code's secret storage.",
      password: true, ignoreFocusOut: true, validateInput: (v) => (/^ns_[0-9a-f]+$/.test(v.trim()) ? null : "Expected ns_…"),
    });
    if (!key) return;
    await ctx.secrets.store(SECRET_KEY, key.trim());
    folderCache = null;
    tree.onDidChange.fire();
    vscode.window.showInformationMessage("NoteSmith API key saved.");
  },

  async linkFolder() {
    await needWorkspace();
    const w = await pickWorkspace();
    if (!w) return;
    folderCache = null;
    const all = await folders(w.id);
    const p = await vscode.window.showQuickPick(
      all.map((f) => ({ label: folderPath(f, all), description: `${f._count?.documents ?? 0} notes`, f }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      { placeHolder: "Folder to link to this project", matchOnDescription: true });
    if (!p) return;
    await save("workspaceId", w.id);
    await save("folderId", p.f.id);
    tree.onDidChange.fire();
  },

  async linkVault() {
    await needWorkspace();
    const dir = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Use this vault folder" }))?.[0]?.fsPath;
    if (!dir) return;
    if (!(await unlock(dir))) return;
    // The vault index only knows DB folder ids; names come from the API when a key is set.
    const ids = await vault.roots();
    let named = [];
    try {
      const ws = cfg().get("workspaceId") || (await pickWorkspace())?.id;
      if (ws) named = await folders(ws);
    } catch { /* no key or offline: fall back to ids */ }
    const items = (ids.length ? ids : named.map((f) => f.id)).map((id) => {
      const f = named.find((x) => x.id === id);
      return { label: f ? folderPath(f, named) : id, id, name: f?.name ?? "Vault" };
    });
    if (!items.length) throw new Error("This vault has no notes yet and no folders could be listed — add a note to it in NoteSmith first.");
    const p = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: "Vault folder to link" });
    if (!p) return;
    await ctx.workspaceState.update(VAULT_DIR, dir);
    await save("vaultFolderId", p.id);
    await save("vaultName", p.name);
    tree.onDidChange.fire();
  },

  async unlockVault() {
    const dir = ctx.workspaceState.get(VAULT_DIR);
    if (!dir) return commands.linkVault();
    if (await unlock(dir)) tree.onDidChange.fire();
  },

  lockVault() {
    vault = null;
    for (const k of cache.keys()) if (k.startsWith("notesmith-vault:")) cache.delete(k);
    tree.onDidChange.fire();
  },

  async unlink() {
    for (const k of ["workspaceId", "folderId", "vaultFolderId", "vaultName"]) await save(k, undefined);
    await ctx.workspaceState.update(VAULT_DIR, undefined);
    commands.lockVault();
  },

  async newNote(n) {
    const target = n ?? (await defaultTarget());
    if (!target) return;
    const title = await vscode.window.showInputBox({ prompt: "Note title", value: "Untitled" });
    if (title === undefined) return;
    let uri;
    if (target.kind === "server" || target.kind === "sfolder") {
      const d = await api("/docs", { method: "POST", body: { workspaceId: cfg().get("workspaceId"), folderId: target.folderId ?? target.id, title, content: "" } });
      uri = docUri("notesmith", d.id, d.title);
    } else {
      if (!vault) throw new Error("Unlock the vault first.");
      const entry = await createVaultNote(target.kind === "ventry" ? target.entry.id : null, title, { type: "doc", content: [{ type: "paragraph" }] });
      uri = docUri("notesmith-vault", entry.id, title);
    }
    tree.onDidChange.fire();
    await vscode.window.showTextDocument(uri);
  },

  refresh() {
    folderCache = null;
    cache.clear();
    tree.onDidChange.fire();
  },

  async copyMcpSetup() {
    const port = cfg().get("mcpPort");
    if (!port) throw new Error("Set “notesmith.mcpPort” to a port number to enable the Claude Code bridge.");
    const cmd = `claude mcp add --transport http --scope user notesmith-vault http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${await mcpToken()}"`;
    await vscode.env.clipboard.writeText(cmd);
    await startMcp();
    vscode.window.showInformationMessage("Copied the Claude Code setup command. Run it once in a terminal, then restart Claude Code (or /mcp → reconnect).");
  },

  openInBrowser(n) {
    const path = n?.kind === "sdoc" ? `/docs/${n.id}` : n?.kind === "ventry" ? `/vault/${n.entry.id}` : "/dashboard";
    vscode.env.openExternal(vscode.Uri.parse(apiBase() + path));
  },
};

async function defaultTarget() {
  const r = await roots();
  if (r.length <= 1) return r[0] ?? (vscode.window.showWarningMessage("Link a NoteSmith folder or vault first."), null);
  return (await vscode.window.showQuickPick(r.map((x) => ({ label: x.label, x })), { placeHolder: "Create the note in…" }))?.x;
}

async function unlock(dir) {
  const secret = await vscode.window.showInputBox({ prompt: "Vault passphrase (or backup code)", password: true, ignoreFocusOut: true });
  if (!secret) return false;
  vault = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Unlocking vault…" },
    () => Vault.unlock(dir, secret)); // PBKDF2 at 600k iterations takes a moment
  return true;
}

// ------------------------------------------------------------------ MCP bridge
// The linked vault folder only — a note elsewhere is "not found". Errors are worded for
// Claude to relay to the user.
function needVault() {
  if (!cfg().get("vaultFolderId")) throw new Error("No vault is linked in this VS Code window.");
  if (!vault) throw new Error("The vault is locked. Ask the user to run “NoteSmith: Unlock Vault” in VS Code.");
}
async function linkedNote(id) {
  const n = await vaultNote(id);
  if (!n || n.entry.vaultFolderId !== cfg().get("vaultFolderId")) throw new Error(`No note ${id} in the linked vault.`);
  return n;
}
// A tab holding this note must re-read it, or its stale buffer wins on the next save.
function noteChanged(id) {
  for (const k of [...cache.keys()]) {
    const uri = vscode.Uri.parse(k);
    if (uri.scheme === "notesmith-vault" && idOf(uri) === id) {
      cache.delete(k);
      fileChanged.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }
  }
  tree.onDidChange.fire();
}

const mcpNotes = {
  async list() {
    needVault();
    const fid = cfg().get("vaultFolderId");
    return {
      window: vscode.workspace.name, vault: cfg().get("vaultName"),
      notes: (await vault.index()).entries.filter((e) => e.vaultFolderId === fid)
        .map(({ id, title, kind, parentId, updatedAt }) => ({ id, title, kind, parentId: parentId ?? null, updatedAt })),
    };
  },
  async read(id) {
    needVault();
    const n = await linkedNote(id);
    return { id, title: n.entry.title, markdown: n.text, readonly: n.why.length > 0, ...(n.why.length && { readonlyBecause: n.why }) };
  },
  async write({ id, title, parentId, markdown }) {
    needVault();
    if (!id) {
      if (!title?.trim()) throw new Error("`title` is required to create a note.");
      if (parentId) await linkedNote(parentId);
      const e = await createVaultNote(parentId, title.trim(), md.markdownToTiptapJson(markdown));
      tree.onDidChange.fire();
      return { id: e.id, created: true };
    }
    const n = await linkedNote(id);
    if (n.entry.kind === "folder") throw new Error(`${id} is a folder, not a note.`);
    if (n.why.length) throw new Error(`Read-only: this note has ${n.why.join(", ")} content Markdown can't round-trip. Edit it in NoteSmith.`);
    if (markdown === n.text) return { id, unchanged: true };
    await vault.saveDoc(n.entry, md.markdownToTiptapJson(markdown));
    noteChanged(id);
    return { id, updated: true };
  },
};

async function mcpToken() {
  let t = await ctx.secrets.get(MCP_TOKEN);
  if (!t) await ctx.secrets.store(MCP_TOKEN, (t = crypto.randomBytes(32).toString("hex")));
  return t;
}

// ponytail: one fixed port per machine, so only the first VS Code window with a linked vault
// serves; the others warn. Per-window ports would need a per-window `claude mcp add`.
async function startMcp() {
  const port = cfg().get("mcpPort");
  if (mcpServer || !port || !cfg().get("vaultFolderId")) return;
  try {
    mcpServer = await mcp.serve(port, await mcpToken(), mcpNotes);
    mcpDefsChanged.fire();
  } catch (err) {
    vscode.window.showWarningMessage(err.code === "EADDRINUSE"
      ? `NoteSmith: port ${port} is already in use (another VS Code window?), so Claude Code can't reach this window's vault.`
      : `NoteSmith: couldn't start the Claude Code bridge: ${err.message}`);
  }
}

function stopMcp() {
  const s = mcpServer;
  mcpServer = null;
  mcpDefsChanged.fire();
  return new Promise((r) => (s ? s.close(() => r()) : r()));
}

function activate(context) {
  ctx = context;
  const reg = (d) => context.subscriptions.push(d);
  reg(vscode.workspace.registerFileSystemProvider("notesmith", fsProvider, { isCaseSensitive: true }));
  reg(vscode.workspace.registerFileSystemProvider("notesmith-vault", fsProvider, { isCaseSensitive: true }));
  reg(vscode.window.registerTreeDataProvider("notesmith.notes", treeProvider));
  for (const [name, fn] of Object.entries(commands)) {
    reg(vscode.commands.registerCommand(`notesmith.${name}`, async (...args) => {
      try { await fn(...args); } catch (err) { vscode.window.showErrorMessage(err.message); }
    }));
  }
  // Copilot (and any other VS Code MCP client) picks the bridge up from here, with the token
  // passed as a header — nothing to paste, and it never lands in a config file. Only the
  // window that is actually serving offers it. Older VS Code lacks the API; Claude Code's
  // copied command still works there.
  if (vscode.lm?.registerMcpServerDefinitionProvider) {
    reg(vscode.lm.registerMcpServerDefinitionProvider("notesmith.vault", {
      onDidChangeMcpServerDefinitions: mcpDefsChanged.event,
      async provideMcpServerDefinitions() {
        const port = mcpServer?.address()?.port;
        if (!port) return [];
        return [new vscode.McpHttpServerDefinition("NoteSmith Vault", vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`),
          { Authorization: `Bearer ${await mcpToken()}` })];
      },
    }));
  }
  reg(vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("notesmith")) return;
    commands.refresh();
    if (e.affectsConfiguration("notesmith.mcpPort")) await stopMcp();
    startMcp();
  }));
  startMcp();
}

module.exports = { activate, deactivate() { vault = null; return stopMcp(); } };
