import { Fragment, createElement, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { imageSource } from "../../shared/types";
import { mailLink, mailStyle, parseMailContent, privateMailLink, type MailContentNode } from "../../shared/mail-content";
import { segmentPrivateParts, type PrivacySegment } from "../privacy";

type Props = {
  html: string | null | undefined;
  showImages: boolean;
  renderText: (text: string, segments?: readonly PrivacySegment[]) => ReactNode;
  redactText: (text: string) => string;
  privacy: boolean;
  privateNames?: readonly string[];
  fallbackText?: string;
  fallback?: ReactNode;
};

// Parent owns opening-specific consent and text redaction. Hooks: formatted-mail,
// formatted-mail-fallback, formatted-mail-image, formatted-mail-image-placeholder,
// formatted-mail-image-status.
export function FormattedMail({ html, showImages, renderText, redactText, privacy, privateNames = [], fallbackText = "", fallback }: Props) {
  const nodes = useMemo(() => typeof html === "string" ? parseMailContent(html) : null, [html]);
  const textParts = nodes ? contentParts(nodes) : [];
  const privateParts = privacy ? segmentPrivateParts(textParts, privateNames) : undefined;
  let textIndex = 0;
  const render = (node: MailContentNode, key: number): ReactNode => {
    if (typeof node === "string") return <Fragment key={key}>{renderText(node, privateParts?.[textIndex++])}</Fragment>;
    const { tag, attributes: a, children } = node;
    const style: CSSProperties = {};
    // Legacy email presentation attributes pass through the same CSS validators.
    Object.assign(style, mailStyle([
      a.bgcolor && `background-color:${a.bgcolor}`, a.color && `color:${a.color}`,
      a.valign && `vertical-align:${a.valign}`,
      a.width && `width:${/^\d+$/.test(a.width) ? a.width + "px" : a.width}`,
      a.height && `height:${/^\d+$/.test(a.height) ? a.height + "px" : a.height}`,
    ].filter(Boolean).join(";")));
    if (tag === "font" && /^[1-7]$/.test(a.size || "")) style.fontSize = [10, 13, 16, 18, 24, 32, 48][Number(a.size) - 1];
    Object.assign(style, legacyAlign(tag, (a.align || "").toLowerCase()));
    Object.assign(style, mailStyle(a.style || ""));
    // Sender sizes are already bounded; scale absolute sizes once, including legacy fonts.
    if (style.fontSize) style.fontSize = `calc(${typeof style.fontSize === "number" ? `${style.fontSize}px` : style.fontSize} * var(--text-scale, 1))`;
    // Quotes take the app's own inset and bar, so nested replies keep their width.
    if (tag === "blockquote") for (const property of Object.keys(style) as (keyof CSSProperties)[])
      if (/^(margin|padding|border)/.test(property)) delete style[property];
    delete style.color;
    style.backgroundColor = "transparent";
    if (style.borderColor) style.borderColor = "var(--line)";
    for (const property of ["border", "borderTop", "borderRight", "borderBottom", "borderLeft"] as const) {
      if (style[property]) style[property] = String(style[property]).replace(/^(\d+(?:\.\d+)?px (?:solid|dashed|dotted) ).+$/, "$1var(--line)");
    }
    if (tag === "img") {
      // An empty box at the image's size keeps the sender layout; small icon
      // cells would otherwise wrap the reason one letter per line.
      if (!showImages) return <ImagePlaceholder key={key} style={style} reason="Image blocked. Use Show images to load it." />;
      const src = imageSource(a.src || "");
      if (privacy && (privateMailLink(a.src || "", redactText) || (src && privateMailLink(src, redactText))))
        return <span key={key} className="formatted-mail-image-status">Image unavailable while personal information is hidden.</span>;
      return src ? <FormattedImage key={`${key}:${src}`} src={src} alt={redactText(a.alt || "").slice(0, 500)} style={style} /> :
        <span key={key} className="formatted-mail-image-status">Unsupported image.</span>;
    }
    const props: Record<string, unknown> = { key, style };
    let element = tag === "font" ? "span" : tag === "center" ? "div" : tag;
    if (tag === "a") {
      const href = mailLink(a.href || "");
      if (href && (!privacy || (!privateMailLink(a.href, redactText) && !privateMailLink(href, redactText)))) {
        style.color = "var(--link)";
        // Card-style links set no decoration; plain links keep an underline.
        style.textDecoration ??= "underline";
        Object.assign(props, { href, target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" });
      }
      else element = "span";
    }
    if (tag === "td" || tag === "th") {
      for (const [attribute, property] of [["colspan", "colSpan"], ["rowspan", "rowSpan"]]) {
        if (/^\d{1,2}$/.test(a[attribute] || "") && Number(a[attribute]) >= 1 && Number(a[attribute]) <= 20)
          props[property] = Number(a[attribute]);
      }
    }
    if (tag === "table") {
      for (const [attribute, property] of [["cellpadding", "cellPadding"], ["cellspacing", "cellSpacing"], ["border", "border"]]) {
        if (/^\d{1,2}$/.test(a[attribute] || "") && Number(a[attribute]) <= (attribute === "border" ? 4 : 24))
          props[property] = Number(a[attribute]);
      }
    }
    if (tag === "ol" && /^-?\d{1,4}$/.test(a.start || "")) props.start = Number(a.start);
    const content = children.map(render);
    // Consume the same block separator used by cross-leaf privacy matching.
    if (blockTags.has(tag)) textIndex++;
    if (["br", "hr", "col"].includes(tag)) return createElement(element, props);
    return createElement(element, props, content);
  };
  const formatted = !!nodes && !!(textParts.join("").trim() || hasImage(nodes));
  return <div className={formatted ? "formatted-mail" : "formatted-mail formatted-mail-fallback"}
    style={{ maxWidth: "100%", minWidth: 0, overflow: "auto", overflowWrap: "anywhere", contain: "layout paint", isolation: "isolate", whiteSpace: formatted ? "normal" : "pre-wrap" }}>
    {formatted ? nodes.map(render) : fallback ?? renderText(fallbackText)}
  </div>;
}

// Holds a blocked image's place at its own size (24px when unsized); the reason
// is a label and tooltip because a small icon cell cannot fit it as text.
function ImagePlaceholder({ style, reason }: { style: CSSProperties; reason: string }) {
  return <span className="formatted-mail-image-placeholder" role="img" aria-label={reason} title={reason}
    style={{ width: style.width ?? 24, height: style.height ?? 24 }} />;
}

function FormattedImage({ src, alt, style }: { src: string; alt: string; style: CSSProperties }) {
  const [status, setStatus] = useState("loading");
  // `display: contents` keeps the image in the sender's line, so its own
  // vertical-align and float apply as they would in a mail client.
  return <span className="formatted-mail-image" style={{ display: "contents" }}>
    {status !== "error" && <img src={src} alt={alt} referrerPolicy="no-referrer" decoding="async" loading="lazy"
      // With a width, auto height keeps the shape when max-width narrows it;
      // icons sized only by height keep that height.
      style={{ ...style, maxWidth: "100%", height: style.width || !style.height ? "auto" : style.height }}
      onLoad={() => setStatus("loaded")} onError={() => setStatus("error")} />}
    {status !== "loaded" && <span className="formatted-mail-image-status" role="status">
      {status === "error" ? "Image could not be loaded." : "Loading image…"}
    </span>}
  </span>;
}

// HTML's align attribute as browsers apply it: a centered table gets auto
// margins, an aligned image floats, and other elements use the -webkit- text
// alignment that also centers nested tables, which mail layouts rely on.
function legacyAlign(tag: string, align: string): CSSProperties {
  if (tag === "center") return { textAlign: "-webkit-center" as CSSProperties["textAlign"] };
  if (tag === "table") return align === "center" ? { marginLeft: "auto", marginRight: "auto" }
    : align === "right" ? { marginLeft: "auto" } : {};
  if (tag === "img") return align === "left" || align === "right" ? { float: align }
    : /^(top|middle|bottom|baseline)$/.test(align) ? { verticalAlign: align } : {};
  if (align === "justify") return { textAlign: "justify" };
  return /^(left|center|right)$/.test(align) ? { textAlign: `-webkit-${align}` as CSSProperties["textAlign"] } : {};
}

const blockTags = new Set("div p br hr h1 h2 h3 h4 h5 h6 blockquote pre ul ol li table tr td th caption center".split(" "));
function contentParts(nodes: MailContentNode[]): string[] {
  return nodes.flatMap((node) => typeof node === "string" ? [node] :
    [...contentParts(node.children), ...(blockTags.has(node.tag) ? ["\n"] : [])]);
}

function hasImage(nodes: MailContentNode[]): boolean {
  return nodes.some((node) => typeof node !== "string" && ((node.tag === "img" && !!imageSource(node.attributes.src || "")) || hasImage(node.children)));
}
