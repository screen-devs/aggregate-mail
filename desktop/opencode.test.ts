import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parse } from "jsonc-parser";
import { openCodeConfig, openCodeMcpEntry } from "../shared/opencode.js";
import { MAX_CONFIG_BYTES, openCodeConfigDir, setupOpenCode, type OpenCodeSetupOptions } from "./opencode.js";

// Every test uses a temporary directory and a synthetic credential. Nothing here
// reads or writes a real user OpenCode config or authentication database.
const root = mkdtempSync(path.join(tmpdir(), "emc2-opencode-"));
after(() => rmSync(root, { recursive: true, force: true }));

const token = "a".repeat(64);
const posixOnly = process.platform === "win32" ? "requires POSIX symlink and permission semantics" : false;

function workspace() {
  const home = mkdtempSync(path.join(root, "home-"));
  const xdg = path.join(home, "xdg");
  const dir = path.join(xdg, "opencode");
  const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: xdg };
  return { home, xdg, dir, env };
}

function run(
  env: Record<string, string | undefined>,
  home: string,
  overrides: Partial<Pick<OpenCodeSetupOptions, "confirmReplace" | "revalidate">> = {},
) {
  return setupOpenCode({ credential: token, env, home, confirmReplace: () => true, revalidate: () => true, ...overrides });
}

test("creates a new private config with the exact shared fragment", () => {
  const { home, env, dir } = workspace();
  const result = run(env, home);
  assert.equal(result, "saved");
  assert.ok(!JSON.stringify(result).includes(token));
  const file = path.join(dir, "opencode.json");
  assert.equal(readFileSync(file, "utf8"), `${openCodeConfig(token)}\n`);
  const entry = JSON.parse(readFileSync(file, "utf8")).mcp.emc2;
  assert.deepEqual(entry, openCodeMcpEntry(token));
  assert.equal(entry.url, "http://127.0.0.1:32145/mcp");
  assert.equal((entry as { headers: { Authorization: string } }).headers.Authorization, `Bearer ${token}`);
  if (!posixOnly) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("is idempotent and leaves no staged or backup files", () => {
  const { home, env, dir } = workspace();
  assert.equal(run(env, home), "saved");
  const file = path.join(dir, "opencode.json");
  const before = readFileSync(file);
  const listing = readdirSync(dir).sort();
  assert.equal(run(env, home), "saved");
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir).sort(), listing);
});

test("adds emc2 to an existing JSON config without touching other keys", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "opencode.json"), `${JSON.stringify({
    model: "anthropic/claude",
    theme: "graphite",
    mcp: { other: { type: "local", command: ["npx", "thing"] } },
  }, null, 2)}\n`);
  assert.equal(run(env, home), "saved");
  const value = JSON.parse(readFileSync(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(value.model, "anthropic/claude");
  assert.equal(value.theme, "graphite");
  assert.deepEqual(value.mcp.other, { type: "local", command: ["npx", "thing"] });
  assert.deepEqual(value.mcp.emc2, openCodeMcpEntry(token));
});

test("preserves comments and unrelated formatting in JSONC", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const source = `{\n\t// keep this heading\n\t"model": "anthropic/claude",\n\t"mcp": {\n\t\t// other server\n\t\t"other": { "type": "local" },\n\t\t"keep": { "enabled": true }\n\t}\n}\n`;
  writeFileSync(path.join(dir, "opencode.jsonc"), source);
  assert.equal(run(env, home), "saved");
  const result = readFileSync(path.join(dir, "opencode.jsonc"), "utf8");
  // Everything before the mcp object is byte-identical, including its comments.
  assert.ok(result.startsWith(source.slice(0, source.indexOf('"mcp"'))), "unrelated top-level content is untouched");
  assert.ok(result.includes("// keep this heading"));
  assert.ok(result.includes("// other server"));
  assert.ok(result.includes('"model": "anthropic/claude"'));
  const value = parse(result, []);
  assert.deepEqual(value.mcp.emc2, openCodeMcpEntry(token));
  assert.deepEqual(value.mcp.other, { type: "local" });
  assert.deepEqual(value.mcp.keep, { enabled: true });
});

test("accepts JSONC trailing commas and preserves the existing entries", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.jsonc");
  const source = `{\n\t"model": "anthropic/claude",\n\t"mcp": {\n\t\t"other": { "type": "local" },\n\t},\n}\n`;
  writeFileSync(file, source);
  assert.equal(run(env, home), "saved");
  const result = readFileSync(file, "utf8");
  const value = parse(result, [], { allowTrailingComma: true });
  assert.deepEqual(value.mcp.emc2, openCodeMcpEntry(token));
  assert.deepEqual(value.mcp.other, { type: "local" });
  assert.equal(value.model, "anthropic/claude");
  assert.ok(readdirSync(dir).includes("opencode.jsonc"));
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("treats an identical emc2 entry as saved without rewriting or confirming", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.jsonc");
  writeFileSync(file, `{\n\t"mcp": { "emc2": ${JSON.stringify(openCodeMcpEntry(token))} }\n}\n`);
  const before = readFileSync(file);
  let asked = 0;
  assert.equal(run(env, home, { confirmReplace: () => { asked++; return true; } }), "saved");
  assert.equal(asked, 0);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), ["opencode.jsonc"]);
});

test("cancels a different existing emc2 entry without changing the file", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  const original = `${JSON.stringify({ mcp: { emc2: { type: "remote", url: "http://old.example/mcp" } } }, null, 2)}\n`;
  writeFileSync(file, original);
  let asked = 0;
  assert.equal(run(env, home, { confirmReplace: () => { asked++; return false; } }), "cancelled");
  assert.equal(asked, 1);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("replaces a different emc2 entry after confirmation and keeps a private backup", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  const original = `${JSON.stringify({
    model: "x",
    mcp: { emc2: { type: "remote", url: "http://old/mcp" }, keep: { enabled: true } },
  }, null, 2)}\n`;
  writeFileSync(file, original);
  let asked = 0;
  assert.equal(run(env, home, { confirmReplace: () => { asked++; return true; } }), "saved");
  assert.equal(asked, 1);
  const value = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(value.mcp.emc2, openCodeMcpEntry(token));
  assert.deepEqual(value.mcp.keep, { enabled: true });
  assert.equal(value.model, "x");
  const backups = readdirSync(dir).filter((name) => name.endsWith(".backup"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), original);
  if (!posixOnly) assert.equal(statSync(path.join(dir, backups[0])).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

const blocked: [string, (file: string) => void][] = [
  ["malformed JSON", (file) => writeFileSync(file, "{ not json")],
  ["an array root", (file) => writeFileSync(file, "[1, 2, 3]\n")],
  ["a scalar root", (file) => writeFileSync(file, "42\n")],
  ["a non-object mcp", (file) => writeFileSync(file, '{"mcp": "nope"}')],
  ["duplicate mcp keys", (file) => writeFileSync(file, '{"mcp": {}, "mcp": {"emc2": {}}}')],
  ["duplicate emc2 keys", (file) => writeFileSync(file, '{"mcp": {"emc2": {"a": 1}, "emc2": {"b": 2}}}')],
  ["an oversize file", (file) => writeFileSync(file, `{"pad": "${"x".repeat(MAX_CONFIG_BYTES)}"}`)],
];
for (const [label, prepare] of blocked)
  test(`refuses ${label} without touching the file`, () => {
    const { home, env, dir } = workspace();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.json");
    prepare(file);
    const before = readFileSync(file);
    assert.equal(run(env, home), "failed");
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(readdirSync(dir), ["opencode.json"]);
  });

test("refuses a symlinked config file", { skip: posixOnly }, () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const real = path.join(home, "elsewhere.json");
  writeFileSync(real, `${JSON.stringify({ mcp: {} })}\n`);
  symlinkSync(real, path.join(dir, "opencode.json"));
  const before = readFileSync(real);
  assert.equal(run(env, home), "failed");
  assert.deepEqual(readFileSync(real), before);
});

test("refuses a symlinked config directory", { skip: posixOnly }, () => {
  const { home, env, xdg } = workspace();
  mkdirSync(xdg, { recursive: true });
  const real = path.join(home, "real-opencode");
  mkdirSync(real);
  symlinkSync(real, path.join(xdg, "opencode"));
  assert.equal(run(env, home), "manual");
  assert.deepEqual(readdirSync(real), []);
});

test("refuses two config files in the same directory", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  writeFileSync(json, "{}\n");
  writeFileSync(jsonc, "{}\n");
  assert.equal(run(env, home), "manual");
  assert.equal(readFileSync(json, "utf8"), "{}\n");
  assert.equal(readFileSync(jsonc, "utf8"), "{}\n");
});

test("refuses a symlinked config root instead of walking it", { skip: posixOnly }, () => {
  const { home } = workspace();
  const realRoot = path.join(home, "real-config");
  mkdirSync(realRoot, { recursive: true });
  const xdg = path.join(home, "xdg");
  symlinkSync(realRoot, xdg);
  assert.equal(setupOpenCode({ credential: token, env: { XDG_CONFIG_HOME: xdg }, home, confirmReplace: () => true, revalidate: () => true }), "manual");
  assert.deepEqual(readdirSync(realRoot), []);
});

test("refuses a directory swapped for a symlink during confirmation", { skip: posixOnly }, () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const original = `${JSON.stringify({ mcp: { emc2: { type: "remote", url: "http://old/mcp" } } }, null, 2)}\n`;
  writeFileSync(path.join(dir, "opencode.json"), original);
  const moved = path.join(home, "moved-opencode");
  assert.equal(run(env, home, { confirmReplace: () => { renameSync(dir, moved); symlinkSync(moved, dir); return true; } }), "manual");
  assert.equal(readFileSync(path.join(moved, "opencode.json"), "utf8"), original);
  assert.deepEqual(readdirSync(moved).filter((name) => /\.(tmp|backup)$/.test(name)), []);
});

test("refuses a config root swapped for a symlink during confirmation", { skip: posixOnly }, () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const original = `${JSON.stringify({ mcp: { emc2: { type: "remote", url: "http://old/mcp" } } }, null, 2)}\n`;
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, original);
  const xdg = path.dirname(dir);
  const realRoot = path.join(home, "real-xdg");
  assert.equal(run(env, home, { confirmReplace: () => { renameSync(xdg, realRoot); symlinkSync(realRoot, xdg); return true; } }), "manual");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(realRoot).filter((name) => /\.(tmp|backup)$/.test(name)), []);
});

test("refuses a same-bytes file replaced by a different inode during confirmation", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const original = `${JSON.stringify({ mcp: { emc2: { type: "remote", url: "http://old/mcp" } } }, null, 2)}\n`;
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, original);
  assert.equal(run(env, home, { confirmReplace: () => { renameSync(file, path.join(home, "keep.json")); writeFileSync(file, original); return true; } }), "failed");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("refuses a second config file that appears during confirmation", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const original = `${JSON.stringify({ mcp: { emc2: { type: "remote", url: "http://old/mcp" } } }, null, 2)}\n`;
  const json = path.join(dir, "opencode.json");
  const jsonc = path.join(dir, "opencode.jsonc");
  writeFileSync(json, original);
  assert.equal(run(env, home, { confirmReplace: () => { writeFileSync(jsonc, "{}\n"); return true; } }), "manual");
  assert.equal(readFileSync(json, "utf8"), original);
  assert.equal(readFileSync(jsonc, "utf8"), "{}\n");
});

test("defers to manual setup for a custom config path or content", () => {
  const { home, dir } = workspace();
  const base = path.dirname(dir);
  for (const env of [
    { XDG_CONFIG_HOME: base, OPENCODE_CONFIG: "/tmp/custom.json" },
    { XDG_CONFIG_HOME: base, OPENCODE_CONFIG_CONTENT: "{}" },
  ])
    assert.equal(run(env, home), "manual");
  assert.equal(existsSync(dir), false);
});

test("refuses a relative XDG_CONFIG_HOME without guessing another directory", () => {
  const { home } = workspace();
  assert.equal(run({ XDG_CONFIG_HOME: "relative/config" }, home), "manual");
  assert.equal(existsSync(path.join(home, ".config")), false);
});

test("uses home/.config/opencode when XDG_CONFIG_HOME is unset", () => {
  const { home } = workspace();
  assert.equal(openCodeConfigDir({}, home), path.join(home, ".config", "opencode"));
  assert.equal(run({}, home), "saved");
  assert.equal(existsSync(path.join(home, ".config", "opencode", "opencode.json")), true);
});

test("refuses a file changed after confirmation and never clobbers it", () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({ mcp: { emc2: { url: "http://old/mcp" } } }));
  const concurrent = `${JSON.stringify({ mcp: { emc2: { url: "http://concurrent/mcp" } }, note: "written elsewhere" }, null, 2)}\n`;
  assert.equal(run(env, home, { confirmReplace: () => { writeFileSync(file, concurrent); return true; } }), "failed");
  assert.equal(readFileSync(file, "utf8"), concurrent);
  assert.deepEqual(readdirSync(dir).filter((name) => /\.(tmp|backup)$/.test(name)), []);
});

test("aborts without writing when trust revalidation fails", () => {
  const { home, env, dir } = workspace();
  assert.equal(run(env, home, { revalidate: () => false }), "failed");
  assert.equal(existsSync(dir), false);
});

test("refuses to replace a file created after inspection", () => {
  const { home, env, dir } = workspace();
  const file = path.join(dir, "opencode.json");
  const concurrent = `${JSON.stringify({ mcp: {} })}\n`;
  const result = run(env, home, {
    revalidate: () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, concurrent);
      return true;
    },
  });
  assert.equal(result, "failed");
  assert.equal(readFileSync(file, "utf8"), concurrent);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("reports a write failure without changing the original", { skip: posixOnly || process.getuid?.() === 0 ? "needs a non-root user for a read-only directory" : false }, () => {
  const { home, env, dir } = workspace();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  const original = `${JSON.stringify({ mcp: { emc2: { url: "http://old/mcp" } } }, null, 2)}\n`;
  writeFileSync(file, original);
  chmodSync(dir, 0o500);
  try {
    assert.equal(run(env, home), "failed");
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
});

test("rejects an invalid credential before any file work", () => {
  const { home, env, dir } = workspace();
  for (const credential of ["short", "B".repeat(64), "", 42 as unknown as string])
    assert.equal(setupOpenCode({ credential, env, home, confirmReplace: () => true, revalidate: () => true }), "failed");
  assert.equal(existsSync(dir), false);
});
