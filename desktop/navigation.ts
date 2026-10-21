export function isLocalNavigation(url: string, origin: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname === "/";
  } catch {
    return false;
  }
}

export function swipeNavigation(direction: string): "back" | "forward" | undefined {
  if (direction === "right") return "back";
  if (direction === "left") return "forward";
}
export function isExternalLink(url: string, origin: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin
      ? parsed.pathname === "/api/oauth/google"
      : parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function trustedWindowSender(event: { sender: unknown; senderFrame: unknown }, contents: {
  mainFrame: unknown; getURL: () => string;
}, origin: string) {
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  try { const url = new URL(contents.getURL()); return url.origin === origin && url.pathname === "/"; }
  catch { return false; }
}
