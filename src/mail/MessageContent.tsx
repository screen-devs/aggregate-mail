import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { imageSource, type Mail, type MailImage, type MailAttachment } from "../../shared/types";
import { privateMailLink } from "../../shared/mail-content";
import { redactPrivateText } from "../privacy";
import { PrivacyContext, Redact } from "../ui/Privacy";
import { FormattedMail } from "./FormattedMail";

export function MessageBody({ text }: { text: string }) {
  const { on, names } = useContext(PrivacyContext);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'“”‘’]+/gi)) {
    if (match.index > 0 && /[\w:/]/.test(text[match.index - 1])) continue;
    let url = match[0];
    // Keep balanced URL delimiters, but leave prose wrappers outside the link.
    let parentheses = url.split(")").length - url.split("(").length;
    let brackets = url.split("]").length - url.split("[").length;
    while (
      /[.,;:!?]$/.test(url) ||
      (url.endsWith(")") && parentheses > 0) ||
      (url.endsWith("]") && brackets > 0)
    ) {
      if (url.endsWith(")")) parentheses--;
      else if (url.endsWith("]")) brackets--;
      url = url.slice(0, -1);
    }
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || /\\|%(?![\da-f]{2})/i.test(url)) continue;
    } catch {
      continue;
    }
    parts.push(<Redact key={`text-${match.index}`} text={text.slice(last, match.index)} />);
    const privateLink = on && privateMailLink(url, (value) => redactPrivateText(value, names));
    parts.push(privateLink ? (
      <span key={match.index}>Private link hidden</span>
    ) : (
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{url}</a>
    ));
    last = match.index + url.length;
  }
  parts.push(<Redact key="tail" text={text.slice(last)} />);
  return <>{parts}</>;
}
export function MessageText({ text }: { text: string }) {
  return <>{text.replace(/\r\n?/g, "\n").split(/\n(?:[ \t\u00a0]*\n)+/)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph, index) => <p key={index}><MessageBody text={paragraph} /></p>)}</>;
}
function ReaderImage({ image, index }: { image: MailImage; index: number }) {
  const { on, names } = useContext(PrivacyContext);
  const [status, setStatus] = useState("loading");
  // Provider metadata may end mid-token at its 500-unit limit.
  const description = on && image.alt.length >= 500 ? `Image ${index + 1}` : image.alt;
  const privateSource = on && privateMailLink(image.src, (value) => redactPrivateText(value, names));
  return <figure>
    {!privateSource && status !== "error" && <img
      src={image.src}
      alt={on ? redactPrivateText(description, names) : description}
      referrerPolicy="no-referrer"
      decoding="async"
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />}
    <figcaption>
      {privateSource ? "Image unavailable while personal information is hidden." :
        status === "loading" ? `Loading image ${index + 1}…` :
        status === "error" ? `Image ${index + 1} could not be loaded.` :
        <Redact text={description || `Image ${index + 1}`} />}
    </figcaption>
  </figure>;
}
export type ContentResult = { html: string | null; images?: MailImage[]; attachments?: MailAttachment[] };
type ImageProps = {
  mail: Pick<Mail, "id" | "images"> & Partial<Pick<Mail, "html" | "body" | "attachments">>;
  loadImages: (id: string) => Promise<{ images: MailImage[] }>;
  loadContent?: (id: string) => Promise<ContentResult>;
  body?: boolean;
};
export function MessageImages(props: ImageProps) {
  return <ImageConsent key={props.mail.id} {...props} />;
}
export function ReaderContent(props: ImageProps & { loadContent: (id: string) => Promise<ContentResult> }) {
  return <ImageConsent key={props.mail.id} {...props} body />;
}
function ImageConsent({ mail, loadImages, loadContent, body }: ImageProps) {
  const { on: privacy, names } = useContext(PrivacyContext);
  const [status, setStatus] = useState("blocked");
  const [consentInPrivacy, setConsentInPrivacy] = useState(false);
  const [images, setImages] = useState<MailImage[]>([]);
  const [content, setContent] = useState<ContentResult>({ html: mail.html ?? null, images: mail.images, attachments: mail.attachments });
  const [contentStatus, setContentStatus] = useState((mail.html === undefined || mail.attachments === undefined) && loadContent ? "loading" : "ready");
  const active = useRef(true);
  const imageRequest = useRef(0);
  const region = useId();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; imageRequest.current++; };
  }, []);
  useEffect(() => {
    setConsentInPrivacy(false);
    if (privacy) { imageRequest.current++; setStatus("blocked"); setImages([]); }
  }, [privacy]);
  const recoverContent = async () => {
    if (!loadContent) return;
    setContentStatus("loading");
    try {
      const result = await loadContent(mail.id);
      if (active.current) { setContent(result); setContentStatus("ready"); }
    } catch {
      if (active.current) setContentStatus("error");
    }
  };
  useEffect(() => {
    if ((mail.html === undefined || mail.attachments === undefined) && loadContent) void recoverContent();
  }, []);
  const show = async () => {
    const request = ++imageRequest.current;
    setConsentInPrivacy(privacy);
    setStatus("loading");
    try {
      const result = mail.images ?? content.images ?? (await loadImages(mail.id)).images;
      if (!active.current || request !== imageRequest.current) return;
      setImages(result.flatMap((image) => {
        const src = imageSource(image.src);
        return src ? [{ src, alt: image.alt }] : [];
      }));
      setStatus("shown");
    } catch {
      if (active.current && request === imageRequest.current) setStatus("error");
    }
  };
  const shown = status === "shown" && (!privacy || consentInPrivacy);
  const gallery = shown && (images.length ? images.map((image, index) =>
    <ReaderImage key={image.src} image={image} index={index} />) :
    <p role="status">No supported remote images in this email. Embedded images are not shown.</p>);
  const textBody = <MessageText text={mail.body || "This email has no plain-text body."} />;
  return <section className="message-images" aria-label="Email content">
    <div className="image-controls">
      <button className="button" type="button"
        aria-expanded={shown} aria-controls={region}
        disabled={status === "loading"}
        onClick={() => {
          if (shown) { imageRequest.current++; setStatus("blocked"); }
          else void show();
        }}>
        {status === "loading" ? "Loading images…" : shown ? "Hide images" :
          status === "error" ? "Try images again" : "Show images"}
      </button>
      <span>Remote images can tell the sender you opened this email.
        {privacy && " Image pixels may contain personal information."}</span>
    </div>
    {body && contentStatus === "loading" && <p role="status">Loading formatted email…</p>}
    {body && contentStatus === "error" && <p role="status">Formatted email is unavailable. The text is shown below. <button type="button" className="link" onClick={() => void recoverContent()}>Try again</button></p>}
    {body && <section aria-label="Attachments"><h2>Attachments</h2>{(content.attachments || []).length ? (content.attachments || []).map((file, index) => <p key={file.id}><Redact text={file.filename || `Attachment ${index + 1}`} /> ({file.size} bytes) {file.unavailable ? "Unavailable within the import limit" : <a href={`/api/messages/${encodeURIComponent(mail.id)}/attachments/${encodeURIComponent(file.id)}`} download>Download attachment {index + 1}</a>}</p>) : <p>{contentStatus === "ready" ? "No cached attachment metadata." : "Attachment metadata is not yet available."}</p>}</section>}
    <div id={region}>
      {status === "error" && <p role="status">Images could not be loaded. The email may be unavailable or archived.</p>}
      {body && <div className="message-body">
        {content.html ? <FormattedMail html={content.html} showImages={shown} privacy={privacy} privateNames={names}
          renderText={(text, segments) => <Redact text={text} segments={segments} />} redactText={(text) => redactPrivateText(text, names)}
          fallback={<>{textBody}{gallery}</>} /> : textBody}
      </div>}
      {(!body || !content.html) && gallery}
    </div>
  </section>;
}
