import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS, LAB_PROMPT } from "../scripts/media/commands.mjs";
import { TRACKS } from "../scripts/verify/tracks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const packageScripts = JSON.parse(read("package.json")).scripts;

// What each guide tells the learner to run.
const GUIDE_BINS = {
  direct: ["claude-gemini", "claude-gemini-status", "claude-gemini-stop", "claude-gemini-turns", "gemini-doctor", "gemini-models", "gemini-lab"],
  litellm: ["claude-gemini-litellm", "gemini-litellm", "gemini-doctor", "gemini-models", "gemini-lab"],
};
const GUIDE_SCRIPTS = {
  direct: ["verify", "verify:plan", "verify:report", "guide", "test"],
  litellm: ["verify:litellm", "verify:litellm:plan", "verify:litellm:report", "guide:litellm", "litellm:setup", "test"],
};

for (const track of Object.values(TRACKS)) {
  const built = fs.existsSync(path.join(ROOT, track.guide));
  const skip = built ? false : `${track.guide} is not built yet: run \`npm run ${track.id === "direct" ? "guide" : "guide:litellm"}\``;
  const html = built ? read(track.guide) : "";
  const results = () => JSON.parse(read(track.resultsFile));
  const label = `${track.id} guide`;

  test(`${label}: one page with nothing left to fill in`, { skip }, () => {
    assert.equal((html.match(/<html\b/g) ?? []).length, 1);
    assert.ok(!/\{\{[^}]*\}\}/.test(html), "an unresolved {{placeholder}} is left");
    assert.match(html, /<html lang="ko">/);
  });

  test(`${label}: nothing is loaded from the network: no external script, style, image or font`, { skip }, () => {
    assert.ok(!/<script[^>]+\bsrc=/i.test(html));
    assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html));
    assert.ok(!/<img[^>]+src=["']https?:/i.test(html));
    assert.ok(!/url\(["']?https?:/i.test(html));
    assert.ok(!/@import/.test(html));
  });

  test(`${label}: element ids are unique and every in-page link points at one`, { skip }, () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, index) => ids.indexOf(id) !== index)}`);
    const targets = new Set(ids);
    for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(targets.has(anchor), `#${anchor} has no target`);
  });

  test(`${label}: every screen capture is embedded in the page and has alt text`, { skip }, () => {
    // The enlarge dialog's <img> is empty on purpose: a click fills it in.
    const page = html.replace(/<dialog id="zoom">[\s\S]*?<\/dialog>/, "");
    const images = [...page.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
    assert.ok(images.length >= 20, `only ${images.length} images`);
    for (const image of images) {
      assert.match(image, /src="data:image\/png;base64,[A-Za-z0-9+/=]{200,}"/, image.slice(0, 80));
      assert.match(image, /alt="[^"]+"/);
    }
  });

  test(`${label}: the video the page plays is the file next to it`, { skip }, () => {
    const source = html.match(/<source src="([^"]+)" type="video\/mp4">/)?.[1];
    assert.equal(source, `${track.assets}/demo.mp4`);
    assert.ok(fs.existsSync(path.join(ROOT, source)), `${source} is missing`);
    assert.ok(fs.statSync(path.join(ROOT, source)).size > 100_000);
    const chapters = JSON.parse(html.match(/var chapters = (\[[\s\S]*?\]);/)[1]);
    assert.ok(chapters.length >= 6);
    assert.deepEqual(chapters.map((chapter) => chapter.start), [...chapters.map((chapter) => chapter.start)].sort((a, b) => a - b));
  });

  test(`${label}: the other guide, and a web copy of the video, are reached through the Pages address`, { skip }, () => {
    const { homepage } = JSON.parse(read("package.json"));
    const other = Object.values(TRACKS).find((candidate) => candidate !== track);
    assert.ok(html.includes(`href="${homepage}${other.guide}"`), `no link to ${homepage}${other.guide}`);
    // The local file first, so the page works offline; the copy on Pages when the page is opened without assets/.
    const sources = [...html.matchAll(/<source src="([^"]+)" type="video\/mp4">/g)].map((match) => match[1]);
    assert.deepEqual(sources, [`${track.assets}/demo.mp4`, `${homepage}${track.assets}/demo.mp4`]);
    // Buffered ahead and played inline, so it starts the moment it is asked to.
    assert.match(html, /<video id="demo" controls preload="auto" playsinline /);
  });

  test(`${label}: the verification numbers on the page are the recorded ones`, { skip }, () => {
    const recorded = results();
    assert.ok(html.includes(`<b>${recorded.summary.passed}/${recorded.summary.cases}</b>`));
    assert.ok(html.includes(`<b>${recorded.summary.checksPassed}/${recorded.summary.checks}</b>`));
    assert.ok(html.includes(`Claude Code ${recorded.environment.claudeCode}`));
    assert.equal(recorded.track, track.id);
    assert.equal(recorded.summary.passed, recorded.summary.cases);
    assert.equal(recorded.summary.invariantsOk, true);
  });

  test(`${label}: the commands the guide tells you to run exist`, { skip }, () => {
    for (const command of GUIDE_BINS[track.id]) {
      assert.ok(html.includes(command), `${command} is not mentioned`);
      assert.ok(fs.existsSync(path.join(ROOT, "bin", command)), `bin/${command} is missing`);
    }
    for (const script of GUIDE_SCRIPTS[track.id]) assert.ok(packageScripts[script], `npm run ${script} is missing`);
  });

  test(`${label}: the screen captures are exactly the ones the guide template uses`, { skip: fs.existsSync(path.join(ROOT, track.assets, "shots")) ? false : "no captures yet" }, () => {
    const used = new Set([...read(track.template).matchAll(/\{\{img:([a-z0-9-]+)\}\}/g)].map((match) => match[1]));
    const files = new Set(fs.readdirSync(path.join(ROOT, track.assets, "shots")).filter((name) => name.endsWith(".png")).map((name) => name.replace(/\.png$/, "")));
    assert.deepEqual([...files].filter((name) => !used.has(name)).sort(), [], "captures nothing uses");
    assert.deepEqual([...used].filter((name) => !files.has(name)).sort(), [], "captures the guide uses but are missing");
  });

  test(`${label}: the prompt and commands the template shows are the ones the recorded session types`, () => {
    const template = read(track.template);
    const typed = COMMANDS[track.id];
    assert.ok(template.includes(LAB_PROMPT), "the coding prompt in the template differs from LAB_PROMPT in scripts/media/commands.mjs");
    for (const name of ["codingLaunch", "printOne", "vision", "turns", "doctor"]) {
      assert.ok(template.includes(typed[name]), `the template does not show the recorded ${name} command: ${typed[name]}`);
    }
  });
}

test("the Claude Code version gemini-doctor calls verified is the one the published verification ran on", () => {
  const doctor = read("src/doctor.mjs");
  const verified = doctor.match(/export const VERIFIED_CLAUDE_CODE = "([\d.]+)"/)[1];
  for (const track of Object.values(TRACKS)) {
    if (!fs.existsSync(path.join(ROOT, track.resultsFile))) continue;
    assert.equal(JSON.parse(read(track.resultsFile)).environment.claudeCode, verified, track.resultsFile);
  }
});
