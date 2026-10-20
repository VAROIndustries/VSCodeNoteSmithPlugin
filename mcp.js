// Loopback MCP server so a Claude Code session can read/write the vault this window has
// unlocked. Streamable-HTTP transport, JSON responses only (no SSE), no SDK — the protocol
// surface we need is five JSON-RPC methods.
//
// Security: bound to 127.0.0.1, bearer token (constant-time compare), and any request with
// an Origin header or an unexpected Host is refused, so a web page can't reach it via
// fetch() or DNS rebinding. The token itself lives in plain text in ~/.claude.json — while
// the vault is unlocked, anything that can read that file can read the vault.
const http = require("http");
const crypto = require("crypto");

const TOOLS = [
  {
    name: "list_notes",
    description: "List every note and folder in the NoteSmith vault linked to this VS Code window (id, title, kind, parentId, updatedAt).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_note",
    description: "Read one vault note as Markdown. `readonly: true` means it holds content Markdown can't round-trip, so write_note will refuse to overwrite it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "write_note",
    description: "Write Markdown into the vault. With `id`: replaces that note's whole content (read it first if you mean to append). Without `id`: creates a new note titled `title`, optionally under the note `parentId`. Returns the note's id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing note to overwrite. Omit to create." },
        title: { type: "string", description: "Title for a new note (required when creating)." },
        parentId: { type: "string", description: "Create the new note under this note/folder id. Omit for the vault root." },
        markdown: { type: "string" },
      },
      required: ["markdown"],
    },
  },
];

const text = (s) => ({ content: [{ type: "text", text: s }] });

/** Pure JSON-RPC dispatcher. `notes` is { list(), read(id), write(args) }; each may throw a user-facing Error. */
async function handle(msg, notes) {
  if (msg.id === undefined) return null; // notification (e.g. notifications/initialized): no reply
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "notesmith-vault", version: "0.2.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: a = {} } = msg.params ?? {};
      try {
        if (name === "list_notes") return ok(text(JSON.stringify(await notes.list(), null, 2)));
        if (name === "read_note") return ok(text(JSON.stringify(await notes.read(String(a.id ?? "")), null, 2)));
        if (name === "write_note") {
          if (typeof a.markdown !== "string") throw new Error("`markdown` must be a string.");
          return ok(text(JSON.stringify(await notes.write(a))));
        }
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      } catch (err) {
        return ok({ ...text(err.message), isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function same(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Resolves to the listening server; rejects (e.g. EADDRINUSE) if the port is taken. */
function serve(port, token, notes) {
  let hosts;
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.origin || !hosts.has(req.headers.host)) return send(403, { error: "Forbidden" });
    if (!same(req.headers.authorization ?? "", `Bearer ${token}`)) return send(401, { error: "Unauthorized" });
    if (req.method === "DELETE") return send(200);
    if (req.method !== "POST") return send(405, { error: "Method not allowed" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 5_000_000) return send(413, { error: "Too large" });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const replies = (await Promise.all([].concat(body).map((m) => handle(m, notes)))).filter(Boolean);
    if (!replies.length) return send(202);
    send(200, Array.isArray(body) ? replies : replies[0]);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port; // the real one when `port` is 0
      hosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
      resolve(server);
    });
  });
}

module.exports = { handle, serve, TOOLS };
