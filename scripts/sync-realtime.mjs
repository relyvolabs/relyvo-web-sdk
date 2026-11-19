// Generated snapshot manager. Never hand-edit src/vendor/realtime.
// --update reads the sibling checkout; --check works in an ordinary checkout.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, "../relyvo-realtime");
const vendor = resolve(root, "src/vendor/realtime");
const names = ["index.ts", "types.ts"];
const manifestPath = resolve(vendor, "provenance.json");
const hash = (content) => createHash("sha256").update(content).digest("hex");
const mode = process.argv[2] ?? "--check";
if (!["--check", "--check-upstream", "--update"].includes(mode)) throw new Error("Use --check, --check-upstream or --update");
if (mode === "--update") {
  const dirty = execFileSync("git", ["-C", upstream, "status", "--porcelain", "--", "sdk/javascript/src"], { encoding: "utf8" });
  const commit = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const files = {};
  for (const name of names) {
    const bytes = readFileSync(resolve(upstream, "sdk/javascript/src", name));
    files[name] = hash(bytes);
    writeFileSync(resolve(vendor, name), bytes);
  }
  writeFileSync(manifestPath, JSON.stringify({ source: "relyvo-realtime/sdk/javascript/src", commit, source_dirty: Boolean(dirty.trim()), files }, null, 2) + "\n");
  console.log(`Updated Realtime snapshot from ${commit}`);
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.source !== "relyvo-realtime/sdk/javascript/src" || !/^[0-9a-f]{40}$/.test(manifest.commit) || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...names].sort())) throw new Error("Invalid snapshot provenance");
  for (const name of names) {
    if (hash(readFileSync(resolve(vendor, name))) !== manifest.files[name]) throw new Error(`Vendored ${name} differs from provenance`);
    if (mode === "--check-upstream" && hash(readFileSync(resolve(upstream, "sdk/javascript/src", name))) !== manifest.files[name]) throw new Error(`Canonical ${name} differs from snapshot`);
  }
  console.log(`Realtime snapshot verified (${manifest.commit}${mode === "--check-upstream" ? ", including upstream" : ""})`);
}
