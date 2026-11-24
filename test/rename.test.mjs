import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TRACKS } from "../scripts/verify/tracks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { name, homepage } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Not source: dependencies, recordings, runtime state and the built site. The guides are
// built from their templates, which take the name from package.json.
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".media", ".runtime", ".verify-runs", ".git", "assets", "_site"]);
const SKIPPED_FILES = new Set(["package.json", "package-lock.json", ...Object.values(TRACKS).map((track) => track.guide)]);

function* sourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (!SKIPPED_FILES.has(path.relative(ROOT, file))) yield file;
  }
}

test("the repository name is spelled only in package.json, so renaming the repository is one edit", () => {
  const offenders = [...sourceFiles(ROOT)]
    // package.json's homepage, the GitHub Pages address, names the repository by necessity. The
    // README links through it, and the test below keeps those links in step with the name.
    .filter((file) => fs.readFileSync(file, "utf8").replaceAll(homepage, "").includes(name))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, [], `these files hard-code "${name}"; read it from package.json instead`);
});

test("the lockfile names no package feed, so it installs through whatever registry the reader's npm uses", () => {
  const { packages } = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const resolved = Object.entries(packages)
    .filter(([, entry]) => entry.resolved)
    .map(([location, entry]) => `${location}: ${entry.resolved}`);
  assert.deepEqual(resolved, [], "keep .npmrc in place, or run npm install --package-lock-only --omit-lockfile-registry-resolved");
  assert.match(fs.readFileSync(path.join(ROOT, ".npmrc"), "utf8"), /^omit-lockfile-registry-resolved=true$/m);
});

test("package.json's homepage is the repository's GitHub Pages address, and the README links the guides through it", () => {
  assert.match(homepage, new RegExp(`^https://[a-z0-9-]+\\.github\\.io/${escapeRegExp(name)}/$`), "homepage must be https://<owner>.github.io/<name>/ for the current name");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const target of ["", "guide.html", "guide.html#video", "guide-litellm.html", "guide-litellm.html#video"]) {
    assert.ok(readme.includes(`](${homepage}${target})`), `README.md must link ${homepage}${target}; after renaming the repository, update its github.io links`);
  }
});
