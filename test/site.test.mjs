import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TRACKS } from "../scripts/verify/tracks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? files(path.join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  ));
}

test("the Pages site is the landing page, both guides and the videos they play, with every link resolving", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pages-site-"));
  // The build itself refuses a page that links to a file the site lacks.
  const build = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs"), "--out", out], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);

  const published = files(out).sort();
  assert.deepEqual(published, ["assets/demo.mp4", "assets/litellm/demo.mp4", "guide-litellm.html", "guide.html", "index.html"]);

  const landing = fs.readFileSync(path.join(out, "index.html"), "utf8");
  for (const track of Object.values(TRACKS)) assert.ok(landing.includes(`href="${track.guide}"`), `the landing page links ${track.guide}`);
  fs.rmSync(out, { recursive: true });
});
