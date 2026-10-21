import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareReleaseAssets, releaseAssetNames } from "./prepare-release-assets.mjs";

const version = "1.2.3";
// Explicit fixture names make the test independent of the implementation's list.
const names = [
  "Emc2-1.2.3-win-x64.exe",
  "Emc2-1.2.3-mac-arm64.dmg",
  "Emc2-1.2.3-mac-x64.dmg",
  "Emc2-1.2.3-linux-x86_64.AppImage",
  "latest.yml",
  "latest-linux.yml",
];
const contents = (name) => Buffer.from(`synthetic release asset: ${name}\n`);
const script = fileURLToPath(new URL("./prepare-release-assets.mjs", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "emc2-release-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), contents(name))));
  return directory;
}

async function rejectsWithoutChecksums(directory, pattern) {
  await assert.rejects(prepareReleaseAssets(directory, version), pattern);
  assert.equal((await readdir(directory)).includes("SHA256SUMS.txt"), false);
}

test("complete release set produces exact deterministic SHA256SUMS with six entries", async (t) => {
  const directory = await fixture(t);
  assert.deepEqual(await prepareReleaseAssets(directory, version), [...names].sort());
  const expected = [...names].sort().map((name) =>
    `${createHash("sha256").update(contents(name)).digest("hex")}  ${name}\n`).join("");
  assert.equal(await readFile(path.join(directory, "SHA256SUMS.txt"), "utf8"), expected);
  assert.deepEqual((await readdir(directory)).sort(), [...names, "SHA256SUMS.txt"].sort());
});

for (const name of names) {
  test(`rejects missing ${name} before creating checksums`, async (t) => {
    const directory = await fixture(t);
    await rm(path.join(directory, name));
    await rejectsWithoutChecksums(directory, /Invalid release asset set; missing:/);
  });
  test(`rejects empty ${name}`, async (t) => {
    const directory = await fixture(t);
    await writeFile(path.join(directory, name), "");
    await rejectsWithoutChecksums(directory, /must not be empty/);
  });
  test(`rejects directory named ${name}`, async (t) => {
    const directory = await fixture(t);
    await rm(path.join(directory, name));
    await mkdir(path.join(directory, name));
    await rejectsWithoutChecksums(directory, /regular non-symlink/);
  });
}

for (const replacement of [
  "Emc2-1.2.4-win-x64.exe",
  "Emc2-1.2.3-win-arm64.exe",
  "Emc2-1.2.3-linux-x64.AppImage",
  "Emc2-1.2.3-mac-universal.dmg",
]) {
  test(`rejects mismatched filename ${replacement}`, async (t) => {
    const directory = await fixture(t);
    await rename(path.join(directory, names[0]), path.join(directory, replacement));
    await rejectsWithoutChecksums(directory, /missing:.*unexpected:/);
  });
}

for (const name of ["extra.exe", "Emc2-1.2.3-mac-arm64.zip", "latest-mac.yml", ".hidden"]) {
  test(`rejects unexpected asset ${name}`, async (t) => {
    const directory = await fixture(t);
    await writeFile(path.join(directory, name), "extra");
    await rejectsWithoutChecksums(directory, /unexpected:/);
  });
}

test("rejects symbolic links without following or overwriting their targets", async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, names[0]);
  for (const name of [names[1], "SHA256SUMS.txt"]) {
    await rm(path.join(directory, name), { force: true });
    try {
      await symlink(target, path.join(directory, name), "file");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") {
        t.skip("Windows runner does not permit creating symlinks");
        return;
      }
      throw error;
    }
    await assert.rejects(prepareReleaseAssets(directory, version), /regular non-symlink/);
    assert.deepEqual(await readFile(target), contents(names[0]));
    await rm(path.join(directory, name));
    if (name !== "SHA256SUMS.txt") await writeFile(path.join(directory, name), contents(name));
  }
});

test("retry replaces stale checksums and remains byte-for-byte deterministic", async (t) => {
  const directory = await fixture(t);
  const checksum = path.join(directory, "SHA256SUMS.txt");
  await writeFile(checksum, "stale checksums\n");
  await prepareReleaseAssets(directory, version);
  const first = await readFile(checksum, "utf8");
  await prepareReleaseAssets(directory, version);
  assert.equal(await readFile(checksum, "utf8"), first);
  await writeFile(path.join(directory, names[0]), "changed");
  await prepareReleaseAssets(directory, version);
  assert.notEqual(await readFile(checksum, "utf8"), first);
  assert.equal((await readFile(checksum, "utf8")).includes("SHA256SUMS.txt"), false);
});

test("failed retry preserves the existing checksums", async (t) => {
  const directory = await fixture(t);
  const checksum = path.join(directory, "SHA256SUMS.txt");
  await writeFile(checksum, "previous checksums\n");
  await rm(path.join(directory, names[2]));
  await assert.rejects(prepareReleaseAssets(directory, version), /missing:/);
  assert.equal(await readFile(checksum, "utf8"), "previous checksums\n");
});

test("accepts only exact stable versions", () => {
  for (const value of [undefined, "", "v1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-ci.1", "1.2.3+build", " 1.2.3", "1.2.3\n", "../1.2.3"]) {
    assert.throws(() => releaseAssetNames(value), /exact stable version/);
  }
  assert.equal(releaseAssetNames("0.0.0").length, 6);
  assert.deepEqual(releaseAssetNames(version), [...names].sort());
});

test("CLI accepts directory and version and fails closed on invalid inputs", async (t) => {
  const directory = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const success = run(directory, version);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /validated 6 release assets/);
  assert.notEqual(run(directory).status, 0);
  assert.notEqual(run(directory, version, "extra").status, 0);
  assert.notEqual(run(directory, "v1.2.3").status, 0);
  assert.notEqual(run(path.join(directory, "missing"), version).status, 0);
  assert.notEqual(run(directory, "1.2.4").status, 0);
});
