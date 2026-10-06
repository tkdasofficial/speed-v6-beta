import type React from "react";
import "@/style/Markdown/index.css";

// Lightweight, dependency-free Markdown for AI replies: headings, paragraphs, lists, quotes, code blocks, tables,
// inline code/bold/italic/links. Everything wraps inside its container; only code blocks and tables scroll
// horizontally *inside themselves*, so the chat never scrolls sideways.

function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0], k = `${key}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={k} className="md-code">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={k}>{t.slice(1, -1)}</em>);
    else if (t.startsWith("[")) out.push(<a key={k} href={m[2]} target="_blank" rel="noreferrer">{t.slice(1, t.indexOf("]"))}</a>);
    else out.push(<a key={k} href={t} target="_blank" rel="noreferrer">{t}</a>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const k = `b${i}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k} className="md-pre"><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const lvl = Math.min(h[1]!.length, 4); const Tag = `h${lvl + 1}` as "h2"; blocks.push(<Tag key={k} className={`md-h md-h${lvl}`}>{inline(h[2]!, k)}</Tag>); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(<div key={k} className="md-table"><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}h${j}`)}</th>)}</tr></thead><tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${k}r${ri}${j}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={k} className="md-list">{items.map((t, j) => <li key={j}>{inline(t, `${k}${j}`)}</li>)}</L>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k} className="md-quote">{inline(q.join(" "), k)}</blockquote>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!) && !/^\s*\|.*\|\s*$/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={k} className="md-p">{inline(para.join(" "), k)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
