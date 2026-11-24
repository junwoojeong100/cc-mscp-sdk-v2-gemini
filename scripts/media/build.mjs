#!/usr/bin/env node
// Builds the guide's screen captures and the demo video from recorded PTY sessions.
//
//   node scripts/media/build.mjs                 stills and video
//   node scripts/media/build.mjs --stills        stills only
//   node scripts/media/build.mjs --video         video only
//   node scripts/media/build.mjs --via litellm   the LiteLLM track's recordings, assets and guide template
//
// Marks a scene leaves in its recording steer the replay:
//   title:<step>|<title>|<subtitle>   a title card (video only)
//   caption:<step>|<text>             the caption bar from here on (video only)
//   speed:<n>                         play n times faster from here (a badge shows it)
//   still:<name>|<window title>       save the screen as <assets>/shots/<name>.png (only when
//                                     the track's guide template uses {{img:<name>}})
//   hold:<ms>                         keep the current screen for ms (video only)
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trackNamed } from "../verify/tracks.mjs";
import {
  createReplay, framePage, launchBrowser, maskRulesFor, maskSnapshot, stillPage, titleCardPage, trimSnapshot,
} from "./render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const only = (name) => args.includes(name);
const wantStills = only("--stills") || !only("--video");
const wantVideo = only("--video") || !only("--stills");
const track = trackNamed(args.includes("--via") ? args[args.indexOf("--via") + 1] : "direct");
const recordingsDir = path.join(ROOT, track.recordings);
const assetsDir = path.join(ROOT, track.assets);
const shotsDir = path.join(assetsDir, "shots");
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 10;
const TITLE_MS = 2400;

const recordings = fs.readdirSync(recordingsDir).filter((name) => name.endsWith(".json")).sort();
if (!recordings.length) throw new Error(`No recordings in ${recordingsDir}. Run: npm run media:record`);

const hashOf = (value) => crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
const frames = [];
const stills = [];

for (const file of recordings) {
  const recording = JSON.parse(fs.readFileSync(path.join(recordingsDir, file), "utf8"));
  const rules = maskRulesFor(recording.header);
  const replay = createReplay(recording);
  // A mark is taken one millisecond early: what the scene types right after it (the
  // echo of `exit`, `/exit`) can land in the same millisecond and must not be in the image.
  const marks = recording.frames.filter((frame) => frame.mark).map((frame) => ({ ...frame, t: Math.max(0, frame.t - 1) })).sort((a, b) => a.t - b.t);
  const endMs = Math.max(...recording.frames.map((frame) => frame.t)) + 1_200;
  let real = 0;
  let speed = 1;
  let caption = { step: "", text: "" };
  let nextMark = 0;
  let last = null;
  const stepMs = 1000 / FPS;
  for (;;) {
    await replay.advance(real);
    const snapshot = maskSnapshot(replay.snapshot(), rules);
    while (nextMark < marks.length && marks[nextMark].t <= real) {
      const [directive, ...rest] = marks[nextMark].mark.split(":");
      const value = rest.join(":");
      nextMark += 1;
      if (directive === "title") {
        const [step, title, subtitle] = value.split("|");
        frames.push({ page: "title", step, title, subtitle, duration: TITLE_MS });
        last = null;
      } else if (directive === "caption") {
        const [step, text] = value.split("|");
        caption = { step, text };
      } else if (directive === "speed") {
        speed = Number(value) || 1;
      } else if (directive === "still") {
        const [name, title] = value.split("|");
        stills.push({ name, title: title ?? "Terminal", snapshot });
      } else if (directive === "hold" && last) {
        last.duration += Number(value) || 0;
      }
    }
    const badge = speed > 1 ? `⏩ ×${speed} 배속 (대기 시간 단축)` : "";
    const key = hashOf([snapshot.rows, snapshot.cursor, caption, badge]);
    if (!last || last.key !== key) {
      last = { page: "screen", key, snapshot, caption, badge, duration: 0 };
      frames.push(last);
    }
    if (real >= endMs) {
      last.duration += 600;
      break;
    }
    const nextT = nextMark < marks.length ? marks[nextMark].t : Infinity;
    const step = Math.max(1, Math.min(stepMs * speed, nextT - real, endMs - real));
    last.duration += step / speed;
    real += step;
  }
  replay.dispose();
}

const browser = await launchBrowser();
// Where each title card starts in the finished video, for the guide's chapter buttons.
let clock = 0;
const chapters = [];
for (const frame of frames) {
  if (frame.page === "title") chapters.push({ step: frame.step, title: frame.title, subtitle: frame.subtitle, start: Math.round(clock / 100) / 10 });
  clock += Math.max(frame.duration, 40);
}
try {
  if (wantStills) {
    fs.mkdirSync(shotsDir, { recursive: true });
    // Only the captures the guide template uses are kept, so the shots folder never collects strays.
    const template = fs.readFileSync(path.join(ROOT, track.template), "utf8");
    const used = new Set([...template.matchAll(/\{\{img:([a-z0-9-]+)\}\}/g)].map((match) => match[1]));
    for (const file of fs.readdirSync(shotsDir)) {
      if (file.endsWith(".png") && !used.has(file.slice(0, -4))) fs.rmSync(path.join(shotsDir, file));
    }
    const wanted = stills.filter((still) => used.has(still.name));
    const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1500, height: 900 } });
    const page = await context.newPage();
    for (const still of wanted) {
      await page.setContent(stillPage(trimSnapshot(still.snapshot), { title: still.title }));
      await page.evaluate(() => document.fonts.ready);
      await page.locator("#win").screenshot({ path: path.join(shotsDir, `${still.name}.png`), omitBackground: true });
    }
    await context.close();
    const missing = [...used].filter((name) => !wanted.some((still) => still.name === name));
    console.log(`${wanted.length} stills → ${path.relative(ROOT, shotsDir)}/ (${stills.length - wanted.length} recorded but not used by the guide)`);
    if (missing.length) console.warn(`The guide uses captures that were not recorded: ${missing.join(", ")}`);
  }
  if (wantVideo) {
    const work = path.join(ROOT, ".media", `frames-${track.id}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: WIDTH, height: HEIGHT } });
    const page = await context.newPage();
    const list = [];
    for (const [index, frame] of frames.entries()) {
      const html = frame.page === "title"
        ? titleCardPage({ width: WIDTH, height: HEIGHT, step: frame.step, title: frame.title, subtitle: frame.subtitle })
        : framePage(frame.snapshot, { width: WIDTH, height: HEIGHT, caption: frame.caption.text, step: frame.caption.step, badge: frame.badge });
      await page.setContent(html);
      if (index === 0) await page.evaluate(() => document.fonts.ready);
      const name = `frame-${String(index).padStart(5, "0")}.png`;
      await page.screenshot({ path: path.join(work, name) });
      list.push(`file '${name}'\nduration ${(Math.max(frame.duration, 40) / 1000).toFixed(3)}`);
    }
    await context.close();
    list.push(`file '${`frame-${String(frames.length - 1).padStart(5, "0")}.png`}'`);
    fs.writeFileSync(path.join(work, "frames.txt"), `${list.join("\n")}\n`);
    fs.mkdirSync(assetsDir, { recursive: true });
    const out = path.join(assetsDir, "demo.mp4");
    const encoded = spawnSync("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "frames.txt"),
      "-vf", `fps=30,scale=${WIDTH}:${HEIGHT},format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-movflags", "+faststart", out,
    ], { encoding: "utf8" });
    if (encoded.status !== 0) throw new Error(`ffmpeg failed: ${encoded.stderr}`);
    fs.copyFileSync(path.join(work, "frame-00000.png"), path.join(assetsDir, "demo-poster.png"));
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", out], { encoding: "utf8" });
    const { format } = JSON.parse(probe.stdout);
    console.log(`video → ${path.relative(ROOT, out)}  ${Number(format.duration).toFixed(1)} s, ${(Number(format.size) / 1e6).toFixed(2)} MB, ${frames.length} distinct frames`);
    fs.writeFileSync(path.join(assetsDir, "media-manifest.json"), `${JSON.stringify({
      note: `Edited replay of real PTY recordings (waits are sped up and labelled). Not verification evidence: see ${track.resultsFile}.`,
      video: { file: "demo.mp4", seconds: Math.round(Number(format.duration) * 10) / 10, bytes: Number(format.size) },
      chapters,
      stills: stills.map((item) => item.name),
    }, null, 2)}\n`);
    fs.rmSync(work, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}
