// One-button OpenCode setup. The main process locates the user's OpenCode
// config, edits only `mcp.emc2`, and writes it back with a private backup. The
// renderer supplies one validated credential and nothing else: no path, config
// text, command or executable ever reaches this helper.
//
// Test parameters (env, home, confirmReplace, revalidate) are internal. The IPC
// layer passes the real process environment and window checks.

import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from "jsonc-parser";
import { isOpenCodeCredential, openCodeConfig, openCodeMcpEntry, type OpenCodeSetupResult } from "../shared/opencode.js";

/** A config larger than this is unsupported and left untouched. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Internal refusal kinds. `location` is an ambiguous or unsafe file location;
 * `config` is an unreadable or malformed file; `changed` means the file changed
 * after inspection. All map to a non-success result without touching the file.
 */
class Refused extends Error {
  constructor(readonly kind: "location" | "config" | "changed") {
    super(kind);
  }
}

export interface OpenCodeSetupOptions {
  credential: string;
  env: Record<string, string | undefined>;
  home: string;
  /** Asked before replacing a different existing `mcp.emc2` entry. */
  confirmReplace: () => boolean;
  /** Rechecked after confirmation and before the first write. */
  revalidate: () => boolean;
}

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The OpenCode user directory, or undefined when the location is ambiguous:
 * a custom config path or content is set, `XDG_CONFIG_HOME` is relative, or no
 * home directory is known. Never the project directory.
 */
export function openCodeConfigDir(
  env: Record<string, string | undefined>,
  home: string,
): string | undefined {
  if (env.OPENCODE_CONFIG?.trim() || env.OPENCODE_CONFIG_CONTENT?.trim()) return undefined;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") {
    if (!path.isAbsolute(xdg)) return undefined;
    return path.join(xdg, "opencode");
  }
  if (!home) return undefined;
  return path.join(home, ".config", "opencode");
}

function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeDirectory(dir: string): void {
  if (!present(dir)) return;
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refused("location");
}

/**
 * The immediate config root that will be created recursively. It is checked for
 * a symlink or non-directory, but its OS-owned ancestors (for example /tmp or
 * /var) are deliberately not walked.
 */
function assertSafeRoot(root: string): void {
  if (!present(root)) return;
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refused("location");
}

/** A byte-free identity: the inode that must not change behind the confirmation. */
interface Identity {
  dev: number;
  ino: number;
  directory: boolean;
}

function identityOf(target: string): Identity | undefined {
  try {
    const info = lstatSync(target);
    return { dev: info.dev, ino: info.ino, directory: info.isDirectory() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(before: Identity | undefined, after: Identity | undefined): boolean {
  if (before === undefined || after === undefined) return before === after;
  return before.dev === after.dev && before.ino === after.ino && before.directory === after.directory;
}

/** The one config file to edit, refusing when both a .json and a .jsonc exist. */
function targetFile(dir: string): string {
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  if (present(json) && present(jsonc)) throw new Refused("location");
  return present(jsonc) ? jsonc : json;
}

type Inspection =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "edit"; text: string; digest: string; replace: boolean };

function inspect(file: string, credential: string): Inspection {
  if (!present(file)) return { kind: "new" };
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Refused("config");
  if (info.size > MAX_CONFIG_BYTES) throw new Refused("config");
  const text = readFileSync(file, "utf8");
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (!tree || errors.length || tree.type !== "object") throw new Refused("config");
  const properties = (node: Node) => node.children ?? [];
  const named = (node: Node, name: string) =>
    properties(node).filter((child) => child.type === "property" && child.children?.[0]?.value === name);
  const mcpKeys = named(tree, "mcp");
  if (mcpKeys.length > 1) throw new Refused("config");
  const mcp = mcpKeys[0]?.children?.[1];
  if (mcp && mcp.type !== "object") throw new Refused("config");
  const emc2Keys = mcp ? named(mcp, "emc2") : [];
  if (emc2Keys.length > 1) throw new Refused("config");
  const existing = emc2Keys[0]?.children?.[1];
  if (existing && JSON.stringify(getNodeValue(existing)) === JSON.stringify(openCodeMcpEntry(credential)))
    return { kind: "unchanged" };
  return { kind: "edit", text, digest: digestOf(text), replace: existing !== undefined };
}

/** Insert or replace only `mcp.emc2`, preserving every other key, comment and indent. */
function withEntry(text: string, credential: string): string {
  const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const edits = modify(text, ["mcp", "emc2"], openCodeMcpEntry(credential), {
    formattingOptions: indent.startsWith("\t")
      ? { insertSpaces: false, tabSize: 1, eol: text.includes("\r\n") ? "\r\n" : "\n" }
      : { insertSpaces: true, tabSize: indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  });
  return applyEdits(text, edits);
}

/** Stage a 0600 file, keep a 0600 backup, then replace atomically or create exclusively. */
function writeFile(dir: string, target: string, content: string, replace: boolean, expect?: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = randomBytes(8).toString("hex");
  const staged = path.join(dir, `.emc2-opencode-${name}.tmp`);
  const backup = replace ? path.join(dir, `.emc2-opencode-${name}.backup`) : undefined;
  let committed = false;
  try {
    const fd = openSync(staged, "wx", 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    if (replace && backup) {
      const original = readFileSync(target);
      const bfd = openSync(backup, "wx", 0o600);
      try { writeFileSync(bfd, original); fsyncSync(bfd); } finally { closeSync(bfd); }
      if (!expect || digestOf(readFileSync(target, "utf8")) !== expect) throw new Refused("changed");
      renameSync(staged, target);
    } else {
      try { linkSync(staged, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Refused("changed");
        throw error;
      }
      unlinkSync(staged);
    }
    committed = true;
  } finally {
    if (!committed)
      for (const leftover of [staged, backup])
        if (leftover) { try { unlinkSync(leftover); } catch { /* best effort cleanup */ } }
  }
}

/**
 * Save one grant's credential into the user's OpenCode config, or report why it
 * could not. Never throws, never logs and never returns a path or credential.
 */
export function setupOpenCode(options: OpenCodeSetupOptions): OpenCodeSetupResult {
  if (!isOpenCodeCredential(options.credential)) return "failed";
  try {
    const dir = openCodeConfigDir(options.env, options.home);
    if (!dir) return "manual";
    const root = path.dirname(dir);
    assertSafeRoot(root);
    assertSafeDirectory(dir);
    const target = targetFile(dir);
    const inspection = inspect(target, options.credential);
    if (inspection.kind === "unchanged") return "saved";
    // Identity is captured before the user is asked so a same-bytes swap, a new
    // symlink or a second config file cannot slip in behind the confirmation.
    const rootBefore = identityOf(root);
    const dirBefore = identityOf(dir);
    const fileBefore = identityOf(target);
    if (inspection.kind === "edit" && inspection.replace && !options.confirmReplace()) return "cancelled";
    if (!options.revalidate()) return "failed";
    assertSafeRoot(root);
    assertSafeDirectory(dir);
    if (!sameIdentity(rootBefore, identityOf(root)) || !sameIdentity(dirBefore, identityOf(dir)) || !sameIdentity(fileBefore, identityOf(target)))
      throw new Refused("changed");
    if (targetFile(dir) !== target) throw new Refused("location");
    if (inspection.kind === "edit") {
      const again = inspect(target, options.credential);
      if (again.kind === "unchanged") return "saved";
      if (again.kind !== "edit" || again.digest !== inspection.digest) throw new Refused("changed");
      writeFile(dir, target, withEntry(inspection.text, options.credential), true, inspection.digest);
    } else {
      writeFile(dir, target, `${openCodeConfig(options.credential)}\n`, false);
    }
    return "saved";
  } catch (error) {
    if (error instanceof Refused) return error.kind === "location" ? "manual" : "failed";
    return "failed";
  }
}
