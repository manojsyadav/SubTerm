import React from "react";
import { invoke } from "@tauri-apps/api/core";

// A small Markdown renderer for the file viewer. It builds React elements and never uses
// innerHTML, because a .md file from a server is untrusted and script in this webview could
// reach Tauri commands. Raw HTML in the source shows as text, and images show their alt text
// instead of loading (the webview never fetches anything itself).

export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { task?: boolean; done?: boolean; blocks: Block[] }[] }
  | { t: "table"; align: ("left" | "center" | "right" | undefined)[]; head: string[]; rows: string[][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// No lookbehind for the escaped `\|`: older macOS WebKit fails to parse it.
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").replace(/\\\|/g, "\0").split("|").map((c) => c.trim().replace(/\0/g, "|"));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^ {0,3}>/.test(l) || ITEM.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push({ t: "code", lang: m[2], text: body.join("\n") });
    } else if ((m = line.match(HEADING))) {
      out.push({ t: "h", level: m[1].length, text: m[2] });
      i++;
    } else if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
    } else if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && /^ {0,3}>/.test(lines[i]); i++) body.push(lines[i].replace(/^ {0,3}> ?/, ""));
      out.push({ t: "quote", blocks: parseMarkdown(body.join("\n")) });
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined));
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
      out.push({ t: "table", align, head, rows });
    } else if ((m = line.match(ITEM))) {
      const indent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const list: Extract<Block, { t: "list" }> = { t: "list", ordered, start: ordered ? parseInt(m[2], 10) : 1, items: [] };
      while (i < lines.length) {
        const im = lines[i].match(ITEM);
        if (!im || im[1].length !== indent || /\d/.test(im[2]) !== ordered) break;
        const width = im[1].length + im[2].length + 1;
        const body = [im[3]];
        // The item continues over lines indented past its marker, and over blank lines followed by one.
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) {
            if (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && (lines[i + 1].match(/^\s*/)![0].length > indent)) { body.push(""); continue; }
            break;
          }
          const lead = l.match(/^\s*/)![0].length;
          if (lead > indent) body.push(l.slice(Math.min(lead, width)));
          else if (!startsBlock(l) && body[body.length - 1] !== "") body.push(l.trim()); // lazy continuation
          else break;
        }
        const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) body[0] = task[2];
        list.items.push({ task: !!task, done: task ? task[1] !== " " : undefined, blocks: parseMarkdown(body.join("\n")) });
        while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1]) && lines[i + 1].match(ITEM)![1].length === indent) i++;
      }
      out.push(list);
    } else {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(body.length && /^ {0,3}=+\s*$/.test(lines[i])); i++) body.push(lines[i].trim());
      // Setext headings: a paragraph line underlined with === or ---.
      const under = lines[i]?.match(/^ {0,3}(=+|-+)\s*$/);
      if (under && body.length) { out.push({ t: "h", level: under[1][0] === "=" ? 1 : 2, text: body.join(" ") }); i++; }
      else if (body.length) out.push({ t: "p", text: body.join("\n") });
      else { out.push({ t: "p", text: lines[i].trim() }); i++; }
    }
  }
  return out;
}

const openLink = (url: string) => { invoke("open_external_url", { url }).catch(() => {}); };
const EXTERNAL = /^(https?:|mailto:)/i;

type Rule = { re: RegExp; render: (m: RegExpExecArray, key: number) => React.ReactNode; wordBound?: boolean };
const RULES: Rule[] = [
  { re: /\\([\\`*_{}[\]()#+\-.!~|>])/g, render: (m) => m[1] },
  { re: /(`+)([\s\S]*?[^`])\1(?!`)/g, render: (m, k) => <code key={k} className="px-1 py-0.5 rounded bg-white/10 text-[0.9em] font-mono text-pink-200">{m[2].trim()}</code> },
  { re: /!\[([^\]]*)\]\([^)]*\)/g, render: (m, k) => <span key={k} className="italic text-zinc-500" title="Image (not loaded)">[image{m[1] ? `: ${m[1]}` : ""}]</span> },
  { re: /\[([^\]]+)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, render: (m, k) => link(m[2], inline(m[1]), k) },
  { re: /<((?:https?:\/\/|mailto:)[^>\s]+)>/g, render: (m, k) => link(m[1], m[1], k) },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/g, render: (m, k) => <strong key={k} className="font-bold text-zinc-50">{inline(m[1])}</strong> },
  { re: /__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/g, render: (m, k) => <strong key={k} className="font-bold text-zinc-50">{inline(m[1])}</strong>, wordBound: true },
  { re: /\*(?=\S)([\s\S]*?\S)\*/g, render: (m, k) => <em key={k}>{inline(m[1])}</em> },
  { re: /_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9_])/g, render: (m, k) => <em key={k}>{inline(m[1])}</em>, wordBound: true },
  { re: /~~(?=\S)([\s\S]*?\S)~~/g, render: (m, k) => <del key={k}>{inline(m[1])}</del> },
];

function link(href: string, children: React.ReactNode, key: number) {
  if (!EXTERNAL.test(href)) return <span key={key} className="text-sky-300" title={href}>{children}</span>;
  return (
    <a key={key} href={href} onClick={(e) => { e.preventDefault(); openLink(href); }} title={href} className="text-sky-300 underline underline-offset-2 hover:text-sky-200 cursor-pointer">
      {children}
    </a>
  );
}

/** Inline Markdown (code, emphasis, links) as React nodes; line breaks inside a paragraph become spaces. */
export function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text, key = 0;
  while (rest) {
    let best: { m: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // `_` emphasis only counts at a word start, so snake_case names and `__init` stay as they are.
      while ((m = rule.re.exec(rest)) && rule.wordBound && m.index > 0 && /[A-Za-z0-9_]/.test(rest[m.index - 1])) rule.re.lastIndex = m.index + 1;
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) { out.push(rest); break; }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(best.rule.render(best.m, key++));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

const H = ["text-2xl border-b border-white/10 pb-1.5", "text-xl border-b border-white/10 pb-1", "text-lg", "text-base", "text-sm", "text-sm text-zinc-400"];

function renderBlocks(blocks: Block[]): React.ReactNode {
  return blocks.map((b, k) => {
    switch (b.t) {
      case "h": return React.createElement(`h${b.level}`, { key: k, className: `font-bold text-zinc-50 mt-5 mb-2 first:mt-0 ${H[b.level - 1]}` }, inline(b.text));
      case "p": return <p key={k} className="my-2.5 leading-relaxed">{inline(b.text)}</p>;
      case "hr": return <hr key={k} className="my-5 border-white/10" />;
      case "code": return (
        <pre key={k} className="my-3 p-3 rounded-lg bg-black/40 border border-white/10 overflow-x-auto text-[12px] leading-5 font-mono text-zinc-200 select-text">
          {b.lang && <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 select-none">{b.lang}</div>}
          <code>{b.text}</code>
        </pre>
      );
      case "quote": return <blockquote key={k} className="my-3 pl-3 border-l-2 border-primary/50 text-zinc-400">{renderBlocks(b.blocks)}</blockquote>;
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={k} start={b.ordered ? b.start : undefined} className={`my-2.5 pl-6 space-y-1 ${b.ordered ? "list-decimal" : "list-disc"}`}>
            {b.items.map((it, j) => (
              <li key={j} className={`${it.task ? "list-none -ml-5" : ""} [&>p]:my-0`}>
                {it.task && <input type="checkbox" checked={it.done} readOnly disabled className="mr-2 align-middle accent-primary" />}
                {it.blocks.length === 1 && it.blocks[0].t === "p" ? inline(it.blocks[0].text) : renderBlocks(it.blocks)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table": return (
        <div key={k} className="my-3 overflow-x-auto">
          <table className="border-collapse text-[13px]">
            <thead><tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] }} className="px-3 py-1.5 border border-white/10 bg-white/[0.04] font-semibold text-zinc-100">{inline(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j} className="even:bg-white/[0.02]">{b.head.map((_, c) => <td key={c} style={{ textAlign: b.align[c] }} className="px-3 py-1.5 border border-white/10 align-top">{inline(r[c] ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
  });
}

export const MarkdownView: React.FC<{ source: string }> = ({ source }) => {
  const blocks = React.useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="flex-1 overflow-auto custom-scrollbar bg-[#0d0d11] select-text">
      <article className="max-w-3xl mx-auto px-8 py-6 text-[14px] text-zinc-300 font-sans">{renderBlocks(blocks)}</article>
    </div>
  );
};
