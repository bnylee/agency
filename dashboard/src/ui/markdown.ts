/**
 * Minimal markdown renderer for bot run reports.
 *
 * Purpose-built rather than a dependency: the reports are written by our own
 * bots to the run-report format in the root CLAUDE.md, so the grammar is narrow
 * and known -- headings, bold, inline code, links, lists, tables, rules.
 *
 * Deliberately free of DOM and animation imports so it stays a pure function
 * that can be tested in node. It renders untrusted-ish local file content into
 * innerHTML, which is exactly the kind of code that should be directly testable.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Inline spans, applied AFTER escaping so report text can never inject markup. */
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) =>
      // Only http(s). A javascript: or data: href would be script execution
      // dressed as a citation, and reports are full of citations.
      /^https?:\/\//i.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>` : text);
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split(/\r?\n/);
  let inList: "ul" | "ol" | null = null;
  let tableBuf: string[] = [];
  let paraBuf: string[] = [];

  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };

  /**
   * Consecutive prose lines are one paragraph, joined with a space.
   *
   * The reports are hard-wrapped at ~90 columns with blank lines between
   * paragraphs — standard markdown. Emitting a <p> per source line, as this did
   * before, turned every wrapped sentence into a stack of paragraphs, each
   * carrying a bottom margin: the panel rendered body prose at 34px leading
   * against the 22px the stylesheet asks for, and the text read as a list of
   * fragments rather than as prose.
   */
  const flushPara = () => {
    if (paraBuf.length === 0) return;
    out.push(`<p>${paraBuf.join(" ")}</p>`);
    paraBuf = [];
  };

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    const rows = tableBuf.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    tableBuf = [];
    const [head, sep, ...body] = rows;
    if (!head || !sep) return;
    out.push("<table><thead><tr>", ...head.map((h) => `<th>${inline(h)}</th>`), "</tr></thead><tbody>");
    for (const r of body) out.push("<tr>", ...r.map((c) => `<td>${inline(c)}</td>`), "</tr>");
    out.push("</tbody></table>");
  };

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); closeList(); tableBuf.push(line.trim()); continue; }
    flushTable();

    // A blank line is the only thing that ends a paragraph.
    if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
    if (/^---+\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${inline(ul[1]!)}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${inline(ol[1]!)}</li>`);
      continue;
    }

    closeList();
    paraBuf.push(inline(line));
  }
  flushPara();
  flushTable();
  closeList();
  return out.join("");
}
