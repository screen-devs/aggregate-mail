import { Parser } from "htmlparser2";

export const MAIL_HTML_LIMIT = 256_000;
// Plain-text conversion leaves image sources as [url]; previews drop them, including one cut off by the stored preview length.
export const previewText = (text: string) => text.replace(/\[(?:https?|cid):[^\]\s]*(?:\]|$)/gi, " ").replace(/\s+/g, " ").trim();
export const MAIL_NODE_LIMIT = 4_000;
// Newsletters nest tables about 50 deep; the node limit bounds the total work.
export const MAIL_DEPTH_LIMIT = 96;

// Keep decoded source bytes intact inside the limit; larger mail uses its text body.
export function boundedMailHtml(value: string | false | undefined): string | null {
  return typeof value === "string" && value.length <= MAIL_HTML_LIMIT && value.trim() ? value : null;
}

export type MailContentNode = string | {
  tag: string;
  attributes: Record<string, string>;
  children: MailContentNode[];
};

const allowedTags = new Set(("div span p br hr h1 h2 h3 h4 h5 h6 strong b em i u s del center " +
  "blockquote pre code ul ol li table thead tbody tfoot tr td th caption colgroup col a img font").split(" "));
const droppedTags = new Set(("head script style title iframe frame frameset object embed svg math " +
  "form input button select option textarea template noscript audio video source link meta base").split(" "));
const allowedAttributes = new Set(("style href src alt width height align valign bgcolor color size " +
  "colspan rowspan cellpadding cellspacing border start").split(" "));

// Unknown wrappers keep their text. Active content and its children are discarded.
export function parseMailContent(html: string): MailContentNode[] | null {
  if (boundedMailHtml(html) === null) return null;
  const roots: MailContentNode[] = [];
  const stack: { children: MailContentNode[]; dropped: boolean }[] = [];
  let count = 0, exceeded = false;
  const budget = () => {
    if (++count <= MAIL_NODE_LIMIT && stack.length < MAIL_DEPTH_LIMIT) return true;
    exceeded = true;
    parser.pause();
    return false;
  };
  const parser = new Parser({
    onopentag(tag, attributes) {
      if (!budget()) return;
      const parent = stack.at(-1);
      const children: MailContentNode[] = [];
      const dropped = !!parent?.dropped || droppedTags.has(tag);
      if (!dropped) (parent?.children ?? roots).push({
        tag: allowedTags.has(tag) ? tag : "span",
        attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => allowedAttributes.has(key))),
        children,
      });
      stack.push({ children, dropped });
    },
    onclosetag() { stack.pop(); },
    ontext(text) {
      if (!budget() || stack.at(-1)?.dropped) return;
      const children = stack.at(-1)?.children ?? roots;
      const last = children.at(-1);
      if (typeof last === "string") children[children.length - 1] = last + text;
      else children.push(text);
    },
  }, { decodeEntities: true });
  parser.end(html);
  return exceeded ? null : roots;
}

// CSS values use a small grammar so escapes, functions that fetch, and custom properties never pass.
export function mailStyle(value: string): Record<string, string | number> {
  const style: Record<string, string | number> = {};
  for (const declaration of value.slice(0, 8_000).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    // Inline styles cannot be overridden here, so the priority flag carries no meaning.
    const input = declaration.slice(colon + 1).trim().toLowerCase().replace(/\s*!\s*important$/, "");
    let output: string | number | null = null;
    if (["color", "background-color", "border-color"].includes(name)) output = color(input);
    if (name === "background") output = color(input);
    if (name === "font-size") output = length(input, 72);
    if (name === "font-weight" && /^(normal|bold|[1-9]00)$/.test(input)) output = input;
    if (name === "font-style" && /^(normal|italic|oblique)$/.test(input)) output = input;
    if (name === "text-align" && /^(left|center|right|justify)$/.test(input)) output = input;
    if (name === "vertical-align" && /^(top|middle|bottom|baseline)$/.test(input)) output = input;
    if (name === "text-decoration" && /^(none|underline|line-through)$/.test(input)) output = input;
    if (name === "white-space" && /^(normal|pre-wrap|pre-line)$/.test(input)) output = input;
    if (name === "border-collapse" && /^(collapse|separate)$/.test(input)) output = input;
    // Layout modes that newsletters use for columns and icon rows. Values that
    // hide content (none, visibility) stay rejected so all sender text is visible.
    if (name === "display" && /^(block|inline|inline-block|table|table-row|table-cell)$/.test(input)) output = input;
    if (name === "float" && /^(left|right|none)$/.test(input)) output = input;
    if (name === "clear" && /^(left|right|both|none)$/.test(input)) output = input;
    if (name === "line-height") {
      if (/^\d+(?:\.\d+)?$/.test(input) && Number(input) >= 1 && Number(input) <= 3) output = input;
      else output = length(input, 96);
    }
    if (/^(width|max-width|height|max-height)$/.test(name)) {
      output = length(input, 1200, name.includes("width"));
      // Zero boxes hide text (preview lines) and would wrap it one letter per line.
      if (output !== null && parseFloat(output) === 0) output = null;
    }
    if (/^(margin|padding)(-(top|right|bottom|left))?$/.test(name)) {
      // `margin: 0 auto` is how most newsletters center their column.
      const parts = input.split(/\s+/).map((part) => part === "auto" && name.startsWith("margin") ? part : length(part, 48));
      if (parts.length <= 4 && parts.every((part) => part !== null)) output = parts.join(" ");
    }
    if (name === "border" || /^border-(top|right|bottom|left)$/.test(name)) output = border(input);
    if (output !== null) {
      const property = (name === "background" ? "background-color" : name)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      style[property] = output;
    }
  }
  return style;
}

function color(value: string): string | null {
  return value.length <= 80 && /^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]{1,20}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s+-]+\))$/.test(value) ? value : null;
}
function length(value: string, maximum: number, percent = false): string | null {
  if (value === "0") return "0";
  const match = /^(\d*\.?\d+)(px|pt|em|rem|ex|ch|%)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (match[2] === "%") return percent && amount <= 100 ? value : null;
  // Mail uses ex and ch for quote insets; at the 16px body size each is about half an em.
  const scale = { px: 1, pt: 4 / 3, em: 16, rem: 16, ex: 8, ch: 8 }[match[2] as "px"];
  const pixels = Math.round(amount * scale * 100) / 100;
  return pixels <= maximum ? `${pixels}px` : null;
}
// A border shorthand in any word order, as Gmail writes `1px #ccc solid`. The
// result is always `width style color`, so the renderer can swap the color.
function border(value: string): string | null {
  const functional = /(?:rgba?|hsla?)\([^)]*\)/.exec(value);
  let colorValue = functional ? color(functional[0]) : null;
  if (functional && !colorValue) return null;
  let width: string | null = null, style: string | null = null;
  const rest = functional ? value.replace(functional[0], " ") : value;
  for (const token of rest.trim().split(/\s+/)) {
    if (!style && /^(solid|dashed|dotted)$/.test(token)) style = token;
    else if (!width && /\d/.test(token) && length(token, 4) !== null) width = length(token, 4);
    else if (!colorValue && color(token)) colorValue = token;
    else return null;
  }
  return style && colorValue ? `${width === "0" ? "0px" : width ?? "1px"} ${style} ${colorValue}` : null;
}

export function mailLink(value: string): string | null {
  if (value.length > 2048 || !/^https?:\/\//i.test(value) || /[\\\s\u0000-\u001f\u007f]|%(?![\da-f]{2})/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// Check both literal and decoded URL text; malformed UTF-8 must not conceal %40.
export function privateMailLink(value: string, redactText: (text: string) => string): boolean {
  for (let pass = 0; pass < 5; pass++) {
    if (redactText(value) !== value || redactText(value.replace(/\+/g, " ")) !== value.replace(/\+/g, " ")) return true;
    let decoded: string;
    try { decoded = decodeURIComponent(value); }
    catch { decoded = value.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
    if (decoded === value) return false;
    value = decoded;
  }
  // Deeply encoded destinations cannot be proven free of hidden text.
  return true;
}
