// TipTap JSON <-> Markdown. Vendored 2026-10-17 from NoteSmith (as of commit b8d7cd0):
//   apps/web/src/lib/tiptapToMarkdown.ts   (tiptapToMarkdown)
//   apps/web/src/lib/import.ts             (markdownToTiptapJson + token walkers)
//   apps/web/src/lib/safeHref.ts           (safeImportHref)
// Same `marked` major as the server so vault notes convert exactly like API notes do.
// Keep in sync by hand if the server converters change.
const { marked } = require("marked");

// ---------------------------------------------------------------- TipTap -> Markdown
const MAX_DEPTH = 100;
const MAX_HEADING_LEVEL = 6;
const MAX_LIST_INDENT = 32;

// code is always innermost (leaf); the rest wrap whole runs of nodes — see the server's
// tiptapToMarkdown.ts for why per-node marks compounded on every round trip.
const RUN_MARKS = new Set(["link", "bold", "italic", "strike"]);
const sameMark = (a, b) => a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);

function wrapMark(inner, mark) {
  if (mark.type === "link") return `[${inner}](${mark.attrs?.href ?? ""})`;
  const d = mark.type === "bold" ? "**" : mark.type === "italic" ? "*" : "~~";
  const [, lead, core, trail] = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return core ? lead + d + core + d + trail : inner;
}

function leaf(node, depth) {
  if (node.type === "text") return node.marks?.some((m) => m.type === "code") ? "`" + (node.text ?? "") + "`" : node.text ?? "";
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "mention") {
    const label = node.attrs?.label ?? node.attrs?.id ?? "";
    return label ? "@" + label : "";
  }
  return inlineNodes(node.content ?? [], depth + 1);
}

function inlineNodes(nodes, depth = 0) {
  if (depth > MAX_DEPTH) return "";
  let out = "";
  for (let i = 0; i < nodes.length; ) {
    let best, end = i + 1;
    for (const m of nodes[i].marks ?? []) {
      if (!RUN_MARKS.has(m.type)) continue;
      let j = i + 1;
      while (j < nodes.length && (nodes[j].marks ?? []).some((x) => sameMark(x, m))) j++;
      if (!best || j > end) { best = m; end = j; }
    }
    if (!best) { out += leaf(nodes[i], depth); i++; continue; }
    const inner = nodes.slice(i, end).map((n) => ({ ...n, marks: (n.marks ?? []).filter((x) => !sameMark(x, best)) }));
    out += wrapMark(inlineNodes(inner, depth + 1), best);
    i = end;
  }
  return out;
}

// Continuation lines indent by the marker's width (3 under "1. "), capped.
function listItemToMd(item, marker, depth, padWidth = marker.length) {
  const body = (item.content ?? []).map((c, i) => {
    const md = blockToMd(c, depth + 1).trimEnd();
    return i === 0 ? md : (/List$/.test(c.type) ? "\n" : "\n\n") + md;
  }).join("");
  const pad = " ".repeat(padWidth);
  return marker + body.split("\n").map((l, i) => (i === 0 || !l ? l : (pad + l).replace(/^ +/, (sp) => sp.slice(0, MAX_LIST_INDENT)))).join("\n") + "\n";
}

function blockToMd(node, depth = 0) {
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
    case "bulletList": return (node.content ?? []).map((it) => listItemToMd(it, "- ", depth)).join("") + "\n";
    case "orderedList": return (node.content ?? []).map((it, i) => listItemToMd(it, `${i + 1}. `, depth)).join("") + "\n";
    case "taskList": return (node.content ?? []).map((it) => listItemToMd(it, `- [${it.attrs?.checked ? "x" : " "}] `, depth, 2)).join("") + "\n";
    case "blockquote": {
      const inner = (node.content ?? []).map((c) => blockToMd(c, depth + 1)).join("").trimEnd();
      return inner.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
    }
    case "callout": {
      const emoji = node.attrs?.emoji ?? "";
      const inner = (node.content ?? []).map((c) => blockToMd(c, depth + 1)).join("").trimEnd();
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
        (cell.content ?? []).map((c) => blockToMd(c, depth + 1)).join("").replace(/\n+$/, "").trim();
      const renderRow = (row) => "| " + (row.content ?? []).map(cellText).join(" | ") + " |";
      const sep = "| " + Array((rows[0].content ?? []).length).fill("---").join(" | ") + " |";
      return [renderRow(rows[0]), sep, ...rows.slice(1).map(renderRow)].join("\n") + "\n\n";
    }
    default:
      return (node.content ?? []).map((c) => blockToMd(c, depth + 1)).join("");
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
  // Frontmatter only at the very top and only if YAML-like — the server's old /m regex ate
  // everything between any two horizontal rules.
  const stripped = markdown.replace(/^---[ \t]*\r?\n(?=[\w-]+[ \t]*:)[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)\s*/, "");
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
  return found;
}

/** True when saving `text` back unchanged would reproduce it — i.e. editing is safe. */
function roundTrips(text) {
  const norm = (s) => s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return norm(tiptapToMarkdown(markdownToTiptapJson(text))) === norm(text);
}

module.exports = { tiptapToMarkdown, markdownToTiptapJson, unsafeTypes, unsafeMarkdown, roundTrips };
