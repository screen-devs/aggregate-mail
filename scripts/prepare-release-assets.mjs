import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const checksumName = "SHA256SUMS.txt";

export function releaseAssetNames(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Expected an exact stable version (for example 1.2.3, without a v prefix)");
  }
  return [
    `Emc2-${version}-win-x64.exe`,
    `Emc2-${version}-mac-arm64.dmg`,
    `Emc2-${version}-mac-x64.dmg`,
    `Emc2-${version}-linux-x86_64.AppImage`,
    "latest.yml",
    "latest-linux.yml",
  ].sort();
}

// This checks the merged publication set. The per-platform updater check still
// owns manifest parsing and version, architecture, size and SHA512 verification.
export async function prepareReleaseAssets(directory, version) {
  const expected = releaseAssetNames(version);
  if (typeof directory !== "string" || !directory) throw new Error("Expected an asset directory");
  const entries = await readdir(directory);
  const missing = expected.filter((name) => !entries.includes(name));
  const extra = entries.filter((name) => !expected.includes(name) && name !== checksumName).sort();
  if (missing.length || extra.length) {
    throw new Error(`Invalid release asset set; missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"}`);
  }
  for (const name of entries) {
    const stat = await lstat(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Release asset must be a regular non-symlink file: ${name}`);
    }
    if (name !== checksumName && stat.size === 0) {
      throw new Error(`Release asset must not be empty: ${name}`);
    }
  }

  const lines = [];
  for (const name of expected) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
    lines.push(`${hash.digest("hex")}  ${name}\n`);
  }
  // Only replace an old checksum after the entire set validates and hashes.
  // A same-filesystem rename avoids leaving a partial checksum on failure.
  const temporary = await mkdtemp(path.join(directory, ".release-checksums-"));
  try {
    const staged = path.join(temporary, checksumName);
    await writeFile(staged, lines.join(""), { flag: "wx" });
    await rename(staged, path.join(directory, checksumName));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return expected;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) {
      throw new Error("Usage: node scripts/prepare-release-assets.mjs <directory> <stable-version>");
    }
    const assets = await prepareReleaseAssets(process.argv[2], process.argv[3]);
    console.log(`PASS: validated ${assets.length} release assets and wrote ${checksumName}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
