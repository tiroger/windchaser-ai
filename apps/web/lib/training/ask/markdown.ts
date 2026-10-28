/**
 * Markdown-lite for Ask answers: the handful of constructs the system prompt
 * allows, parsed into a small tree that React renders as elements. There is
 * no HTML path at all, so model output can never inject markup; anything
 * unrecognised, including raw tags, stays literal text. Links are kept only
 * when they point inside Training.
 *
 * It tolerates half-written input, since it re-parses on every streamed delta:
 * an unclosed ** or ` is shown as typed until its closing mark arrives.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "p"; children: Inline[] }
  | { type: "h"; level: 3 | 4; children: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][]; align: Array<"left" | "right" | "center" | null> }
  | { type: "hr" };

const SAFE_HREF = /^\/training(\/[A-Za-z0-9/_\-.]*)?(\?[A-Za-z0-9=&_\-.%]*)?$/;

export function safeHref(href: string): string | null {
  return SAFE_HREF.test(href) ? href : null;
}

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index];

    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1) {
        out.push({ type: "code", text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**") || rest.startsWith("__")) {
      const mark = rest.slice(0, 2);
      const end = source.indexOf(mark, index + 2);
      if (end > index + 2) {
        out.push({ type: "strong", children: parseInline(source.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if ((char === "*" || char === "_") && /\S/.test(source[index + 1] ?? "")) {
      // An underscore inside a word (snake_case) is not emphasis.
      const before = source[index - 1] ?? " ";
      if (char === "*" || !/[A-Za-z0-9]/.test(before)) {
        const end = source.indexOf(char, index + 1);
        const after = source[end + 1] ?? " ";
        if (end > index + 1 && source[end - 1] !== " " && (char === "*" || !/[A-Za-z0-9]/.test(after))) {
          out.push({ type: "em", children: parseInline(source.slice(index + 1, end)) });
          index = end + 1;
          continue;
        }
      }
    }

    if (char === "[") {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (match) {
        const href = safeHref(match[2]);
        const children = parseInline(match[1]);
        if (href) out.push({ type: "link", href, children });
        else {
          for (const child of children) {
            if (child.type === "text") pushText(out, child.text);
            else out.push(child);
          }
        }
        index += match[0].length;
        continue;
      }
    }

    pushText(out, char);
    index += 1;
  }
  return out;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "h", level: heading[1].length <= 3 ? 3 : 4, children: parseInline(heading[2]) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: "hr" });
      continue;
    }
    if (line.includes("|") && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null,
      );
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitRow(lines[index]).map(parseInline));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", head: head.map(parseInline), rows, align });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const type = bullet ? "ul" : "ol";
      const item = parseInline((bullet ?? numbered)![1]);
      const last = blocks[blocks.length - 1];
      if (last?.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] });
      continue;
    }
    // A wrapped continuation of the previous list item.
    const last = blocks[blocks.length - 1];
    if (!paragraph.length && (last?.type === "ul" || last?.type === "ol") && /^\s{2,}/.test(line)) {
      const item = last.items[last.items.length - 1];
      item.push({ type: "text", text: " " }, ...parseInline(line.trim()));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** Text cut to a length with an ellipsis, for the history sent back to the model. */
export function clip(source: string, max: number): string {
  const text = source.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
