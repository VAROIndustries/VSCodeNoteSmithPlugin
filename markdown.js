// TipTap JSON <-> Markdown. Vendored 2026-10-17 from NoteSmith:
//   apps/web/src/lib/tiptapToMarkdown.ts   (tiptapToMarkdown)
//   apps/web/src/lib/import.ts             (markdownToTiptapJson + token walkers)
//   apps/web/src/lib/safeHref.ts           (safeImportHref)
// Same `marked` major as the server so vault notes convert exactly like API notes do.
// Keep in sync by hand if the server converters change.
const { marked } = require("marked");

// ---------------------------------------------------------------- TipTap -> Markdown
const MAX_DEPTH = 100;
const MAX_HEADING_LEVEL = 6;
const MAX_LIST_INDENT = 16;

// Diverges from the server on purpose: `code` must be the innermost mark. The server applies
// marks in stored order, so bold+code text comes out as `**x**` inside backticks, which
// re-parses as literal asterisks and grows by four more on every round trip.
function applyMarks(text, marks) {
  for (const mark of [...marks].sort((a, b) => (b.type === "code") - (a.type === "code"))) {
    if (mark.type === "bold") text = `**${text}**`;
    else if (mark.type === "italic") text = `*${text}*`;
    else if (mark.type === "strike") text = `~~${text}~~`;
    else if (mark.type === "code") text = `\`${text}\``;
    else if (mark.type === "link") text = `[${text}](${mark.attrs?.href ?? ""})`;
  }
  return text;
}

function inlineNodes(nodes, depth = 0) {
  if (depth > MAX_DEPTH) return "";
  return nodes.map((node) => {
    if (node.type === "text") return applyMarks(node.text ?? "", node.marks ?? []);
    if (node.type === "hardBreak") return "  \n";
    if (node.type === "mention") {
      const label = node.attrs?.label ?? node.attrs?.id ?? "";
      return label ? `@${label}` : "";
    }
    return inlineNodes(node.content ?? [], depth + 1);
  }).join("")
    // Also not on the server: marks are applied per text node, so "**a ****`b`**** c**"
    // comes out where one bold run is split by a code span. Merge adjacent runs.
    // ponytail: bold/strike only; adjacent italic runs fail roundTrips() and open read-only.
    .replace(/\*\*\*\*/g, "").replace(/~~~~/g, "");
}

function listToMd(node, listDepth, depth, marker) {
  const indent = "  ".repeat(Math.min(listDepth, MAX_LIST_INDENT));
  return (node.content ?? []).map((item, i) => {
    const children = item.content ?? [];
    const first = children[0] ? blockToMd(children[0], listDepth, depth + 1).trimEnd() : "";
    const rest = children.slice(1).map((c) => blockToMd(c, listDepth + 1, depth + 1)).join("");
    return `${indent}${marker(i, item)}${first}${rest ? "\n" + rest : ""}\n`;
  }).join("") + "\n";
}

function blockToMd(node, listDepth = 0, depth = 0) {
  if (depth > MAX_DEPTH) return "";
  switch (node.type) {
    case "heading": {
      const raw = Number(node.attrs?.level);
      const level = Number.isFinite(raw) ? Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.floor(raw))) : 1;
      return `${"#".repeat(level)} ${inlineNodes(node.content ?? [], depth + 1)}\n\n`;
    }
    case "paragraph": {
      const text = inlineNodes(node.content ?? [], depth + 1);
      return text ? `${text}\n\n` : "\n";
    }
    case "bulletList": return listToMd(node, listDepth, depth, () => "- ");
    case "orderedList": return listToMd(node, listDepth, depth, (i) => `${i + 1}. `);
    case "taskList": return listToMd(node, listDepth, depth, (_, item) => `- [${item.attrs?.checked ? "x" : " "}] `);
    case "blockquote": {
      const inner = (node.content ?? []).map((c) => blockToMd(c, 0, depth + 1)).join("").trimEnd();
      return inner.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
    }
    case "callout": {
      const emoji = node.attrs?.emoji ?? "";
      const inner = (node.content ?? []).map((c) => blockToMd(c, 0, depth + 1)).join("").trimEnd();
      const lines = inner.split("\n");
      const led = emoji ? [`${emoji} ${lines[0] ?? ""}`.trim(), ...lines.slice(1)] : lines;
      return led.map((l) => `> ${l}`).join("\n") + "\n\n";
    }
    case "codeBlock": {
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${node.attrs?.language ?? ""}\n${code}\n\`\`\`\n\n`;
    }
    case "horizontalRule": return "---\n\n";
    case "image": return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})\n\n`;
    case "table": {
      const rows = node.content ?? [];
      if (rows.length === 0) return "";
      const cellText = (cell) =>
        (cell.content ?? []).map((c) => blockToMd(c, 0, depth + 1)).join("").replace(/\n+$/, "").trim();
      const renderRow = (row) => "| " + (row.content ?? []).map(cellText).join(" | ") + " |";
      const sep = "| " + Array((rows[0].content ?? []).length).fill("---").join(" | ") + " |";
      return [renderRow(rows[0]), sep, ...rows.slice(1).map(renderRow)].join("\n") + "\n\n";
    }
    default:
      return (node.content ?? []).map((c) => blockToMd(c, listDepth, depth + 1)).join("");
  }
}

function tiptapToMarkdown(doc) {
  if (!doc || doc.type !== "doc") return "";
  return (doc.content ?? []).map((c) => blockToMd(c)).join("").trimEnd();
}

// ---------------------------------------------------------------- Markdown -> TipTap
function safeImportHref(href) {
  const stripped = href.replace(/[\t\r\n]/g, "");
  if (/^\s*\/\//.test(stripped) || /^\s*\/[\\]/.test(stripped)) return false;
  return /^(https?:|mailto:|\/|#)/i.test(stripped.trim());
}

function inlineTokensToTiptap(tokens) {
  const nodes = [];
  const wrap = (toks, mark) =>
    inlineTokensToTiptap(toks ?? []).forEach((n) => nodes.push({ ...n, marks: [mark, ...(n.marks ?? [])] }));
  for (const tok of tokens) {
    if (tok.type === "text") {
      if (tok.tokens && tok.tokens.length > 0) nodes.push(...inlineTokensToTiptap(tok.tokens));
      else if (tok.text) nodes.push({ type: "text", text: tok.text });
    } else if (tok.type === "strong") wrap(tok.tokens, { type: "bold" });
    else if (tok.type === "em") wrap(tok.tokens, { type: "italic" });
    else if (tok.type === "del") wrap(tok.tokens, { type: "strike" });
    else if (tok.type === "codespan") nodes.push({ type: "text", text: tok.text, marks: [{ type: "code" }] });
    else if (tok.type === "link") {
      inlineTokensToTiptap(tok.tokens ?? []).forEach((n) => nodes.push(
        safeImportHref(tok.href ?? "")
          ? { ...n, marks: [{ type: "link", attrs: { href: tok.href, target: "_blank" } }, ...(n.marks ?? [])] }
          : n,
      ));
    } else if (tok.type === "br") nodes.push({ type: "hardBreak" });
    else if (tok.type === "escape") nodes.push({ type: "text", text: tok.text });
  }
  return nodes;
}

function blockTokensToTiptap(tokens) {
  const nodes = [];
  for (const tok of tokens) {
    if (tok.type === "heading") {
      nodes.push({ type: "heading", attrs: { level: tok.depth }, content: inlineTokensToTiptap(tok.tokens ?? []) });
    } else if (tok.type === "paragraph") {
      nodes.push({ type: "paragraph", content: inlineTokensToTiptap(tok.tokens ?? []) });
    } else if (tok.type === "blockquote") {
      nodes.push({ type: "blockquote", content: blockTokensToTiptap(tok.tokens ?? []) });
    } else if (tok.type === "code") {
      nodes.push({ type: "codeBlock", attrs: { language: tok.lang ?? null }, content: [{ type: "text", text: tok.text }] });
    } else if (tok.type === "text") {
      const inline = inlineTokensToTiptap(tok.tokens ?? (tok.text ? [{ type: "text", raw: tok.text, text: tok.text }] : []));
      if (inline.length > 0) nodes.push({ type: "paragraph", content: inline });
    } else if (tok.type === "list") {
      nodes.push({
        type: tok.ordered ? "orderedList" : "bulletList",
        content: tok.items.map((item) => ({ type: "listItem", content: blockTokensToTiptap(item.tokens ?? []) })),
      });
    } else if (tok.type === "table") {
      const cell = (type, cellTokens) => ({
        type,
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [{ type: "paragraph", content: inlineTokensToTiptap(cellTokens) }],
      });
      const rows = [];
      if (tok.header?.length) rows.push({ type: "tableRow", content: tok.header.map((h) => cell("tableHeader", h.tokens ?? [])) });
      for (const row of tok.rows ?? []) rows.push({ type: "tableRow", content: row.map((c) => cell("tableCell", c.tokens ?? [])) });
      if (rows.length > 0) nodes.push({ type: "table", content: rows });
    } else if (tok.type === "hr") {
      nodes.push({ type: "horizontalRule" });
    }
    // space / html: skipped, same as the server
  }
  return nodes;
}

function markdownToTiptapJson(markdown) {
  const stripped = markdown.replace(/^---[\s\S]*?^---\s*/m, "");
  const content = blockTokensToTiptap(marked.lexer(stripped));
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

// ---------------------------------------------------------------- Save safety
// Types the Markdown round trip carries without loss. Anything else (taskList, callout,
// image/vault-blob, audioNote, mention, underline, highlight, ...) would be flattened or
// dropped on save — and a vault .enc is the ONLY copy, so those notes open read-only.
const SAFE_NODES = new Set([
  "doc", "paragraph", "heading", "text", "hardBreak", "bulletList", "orderedList", "listItem",
  "blockquote", "codeBlock", "horizontalRule", "table", "tableRow", "tableHeader", "tableCell",
]);
const SAFE_MARKS = new Set(["bold", "italic", "strike", "code", "link"]);

/** Node/mark types in `doc` that would not survive Markdown editing. Empty = safe. */
function unsafeTypes(doc) {
  const found = new Set();
  const walk = (n, depth) => {
    if (!n || typeof n !== "object" || depth > MAX_DEPTH) return;
    if (!SAFE_NODES.has(n.type)) found.add(n.type);
    for (const m of n.marks ?? []) if (!SAFE_MARKS.has(m.type)) found.add(m.type);
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  walk(doc, 0);
  return [...found];
}

/**
 * Server notes only come back as Markdown, so the type walk above can't run on them.
 * Images and task lists are what the server's own Markdown writer drops on PATCH.
 * ponytail: syntax sniff, not a schema check — callouts (rendered as `> emoji`) slip through.
 */
function unsafeMarkdown(md) {
  const found = [];
  if (/!\[[^\]]*\]\(/.test(md)) found.push("image");
  if (/^\s*[-*] \[[ xX]\] /m.test(md)) found.push("taskList");
  // The server's bold+code output (see applyMarks) — its PATCH would add more asterisks.
  if (/`\*\*[^`\n]*\*\*`/.test(md)) found.push("bold code");
  return found;
}

/** True when saving `text` back unchanged would reproduce it — i.e. editing is safe. */
function roundTrips(text) {
  const norm = (s) => s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return norm(tiptapToMarkdown(markdownToTiptapJson(text))) === norm(text);
}

module.exports = { tiptapToMarkdown, markdownToTiptapJson, unsafeTypes, unsafeMarkdown, roundTrips };
