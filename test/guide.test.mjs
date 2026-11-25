import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS, LAB_PROMPT } from "../scripts/media/commands.mjs";
import { TRACKS } from "../scripts/verify/tracks.mjs";
import { LITELLM_VERSION } from "../src/litellm-runtime.mjs";
import { PRIMARY_MODELS } from "../src/model-map.mjs";

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

  test(`${label}: a reader of the web page is told how to get the repository, and that Git is needed`, { skip }, () => {
    const { repository } = JSON.parse(read("package.json"));
    const clone = `git clone ${repository.url.replace(/^git\+/, "")}`;
    const start = html.indexOf('<section id="s1">');
    const end = html.indexOf('<section id="s2">');
    assert.ok(start >= 0 && end > start, "STEP 1 was not found");
    const step1 = html.slice(start, end);
    assert.ok(step1.includes(clone), `STEP 1 does not say: ${clone}`);
    assert.ok(step1.indexOf(clone) < step1.indexOf("npm ci"), "the clone must come before npm ci");
    // gemini-lab (labs/start) runs git init, add and commit, so Git is a prerequisite.
    assert.ok(html.includes("<code>git --version</code>"), "Git is not listed under the prerequisites");
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

// The section for a reader who already runs LiteLLM: guide/litellm.template.html, #existing.
const litellmTemplate = read(TRACKS.litellm.template);
const existingSection = () => {
  const start = litellmTemplate.indexOf('<section id="existing">');
  assert.ok(start >= 0, "the existing-LiteLLM section is missing");
  return litellmTemplate.slice(start, litellmTemplate.indexOf("</section>", start));
};
// What the copy button gives: the markup gone, the entities decoded, the trailing comments dropped.
const textOf = (html) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replace(/[ \t]+#[ \t].*$/gm, "");

test("litellm guide: the existing-LiteLLM section replaces STEP 3, and every step where the two paths part ways points a reader who already has LiteLLM to it", () => {
  const at = (id) => litellmTemplate.indexOf(`<section id="${id}">`);
  assert.ok(at("s3") >= 0 && at("s3") < at("existing") && at("existing") < at("s4"), "it belongs between STEP 3 and STEP 4");
  const toc = litellmTemplate.slice(litellmTemplate.indexOf('<nav class="toc"'), litellmTemplate.indexOf("</nav>"));
  assert.ok(toc.includes('href="#existing"'), "the table of contents does not list it");
  // Where a reader who runs this checkout's LiteLLM and one who already has their own do different things:
  // the choice (summary, prep), the install (STEP 1), the check (STEP 2, doctor --litellm fails without the install),
  // the start (STEP 3), the log commands (STEP 6, gemini-litellm turns/logs read this checkout's gateway) and the cleanup (STEP 9).
  for (const id of ["summary", "prep", "s1", "s2", "s3", "s6", "s9"]) {
    const section = litellmTemplate.slice(at(id), litellmTemplate.indexOf("</section>", at(id)));
    assert.ok(section.includes('href="#existing"'), `${id} does not point a reader who already has LiteLLM to it`);
  }
  // And the other way: a reader who started this checkout's LiteLLM in STEP 3 is sent on to STEP 4.
  assert.ok(existingSection().includes('href="#s4"'), "the section does not send a reader of STEP 3 on to STEP 4");
});

test("litellm guide: the config for an existing LiteLLM is the shipped one's four aliases, with the token as a header and the headers forwarded to those four only", () => {
  const blocks = [...existingSection().matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((match) => textOf(match[1]));
  // A: the models in the config file (and C: the header setting, the same file); B: the models through the API.
  const yaml = blocks.filter((block) => /^(model_list|litellm_settings):/m.test(block)).join("\n");
  const api = blocks.find((block) => block.includes("/model/new"));
  assert.ok(yaml.includes("model_list:") && yaml.includes("litellm_settings:") && api, "a config block is missing");
  const shipped = read("examples/litellm-gemini.yaml");
  assert.deepEqual([...yaml.matchAll(/^\s*- model_name: (\S+)$/gm)].map((match) => match[1]), [...PRIMARY_MODELS]);
  for (const id of PRIMARY_MODELS) assert.match(yaml, new RegExp(`^\\s*model: anthropic/${id}\\b`, "m"));
  assert.equal([...yaml.matchAll(/^\s+x-api-key: os\.environ\/GHCP_BRIDGE_TOKEN\b/gm)].length, PRIMARY_MODELS.length);
  // One bridge, one fixed address.
  assert.deepEqual([...new Set([...yaml.matchAll(/^\s+api_base: (\S+)/gm)].map((match) => match[1]))], ["http://127.0.0.1:4142"]);
  // Same reason as the shipped file: with an api_key LiteLLM 1.97.0 posts the conversation and the key to api.anthropic.com.
  assert.doesNotMatch(yaml, /^\s*api_key:/m);
  assert.doesNotMatch(yaml, /forward_llm_provider_auth_headers/);
  // The headers go to the four aliases, not to every model of the LiteLLM the reader already runs.
  assert.doesNotMatch(yaml, /^\s*forward_client_headers_to_llm_api: true/m);
  const forwarded = yaml.split("forward_client_headers_to_llm_api:")[1] ?? "";
  assert.deepEqual([...forwarded.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]), [...PRIMARY_MODELS]);
  // Whatever the shipped config tells LiteLLM about the models, this one does too.
  const flags = [...shipped.matchAll(/^\s+(supports_\w+): true$/gm)].map((match) => match[1]);
  assert.ok(flags.length > 0);
  for (const flag of flags) assert.match(yaml, new RegExp(`^\\s+${flag}: true$`, "m"), flag);

  // The same models through the API: a model kept in the database takes the token as a value, not as os.environ/.
  assert.deepEqual(api.match(/^for id in (.+); do$/m)?.[1].split(" "), [...PRIMARY_MODELS]);
  assert.match(api, /BRIDGE_URL=http:\/\/127\.0\.0\.1:4142\b/);
  assert.match(api, /"model": "anthropic\/\$id"/);
  assert.match(api, /"x-api-key": "\$BRIDGE_API_KEY"/);
  assert.doesNotMatch(api, /"api_key"/);
  for (const flag of flags) assert.match(api, new RegExp(`"${flag}": true`), flag);
});

test("litellm guide: what the existing-LiteLLM section tells you to run and set exists", () => {
  const section = existingSection();
  const server = read("src/server.mjs");
  assert.equal(packageScripts.bridge, "node src/server.mjs");
  assert.ok(section.includes("npm run bridge"));
  assert.match(server, /process\.env\.BRIDGE_API_KEY/);
  assert.match(server, /readPositiveIntegerEnv\("PORT", 4142\)/);
  assert.match(server, /process\.env\.ALLOW_NON_LOOPBACK/);
  const launcher = read("bin/claude-gemini-litellm");
  for (const name of ["LITELLM_BASE_URL", "LITELLM_API_KEY"]) assert.ok(section.includes(name) && launcher.includes(name), name);
  // The key it warns about: the launcher falls back to this checkout's own master key on a local address.
  assert.match(launcher, /http:\/\/127\.0\.0\.1:\*\|http:\/\/localhost:\*\)[\s\S]*?litellm-master-key/);
  // The launcher messages the guide quotes.
  for (const message of ["LiteLLM rejected the key", "LiteLLM does not serve", "to GET /v1/models"]) assert.ok(read("src/write-litellm-settings.mjs").includes(message), message);
});

test("litellm guide: the existing-LiteLLM section names the pinned LiteLLM version and warns about the Anthropic key", () => {
  const section = existingSection();
  // Its claims about count_tokens were checked on that version. A new pin needs them checked again.
  assert.ok(section.includes(`LiteLLM ${LITELLM_VERSION}`), `re-check the section against LiteLLM ${LITELLM_VERSION}, then name that version in it`);
  assert.ok(section.includes("ANTHROPIC_API_KEY") && section.includes("count_tokens"));
});

test("the Claude Code version gemini-doctor calls verified is the one the published verification ran on", () => {
  const doctor = read("src/doctor.mjs");
  const verified = doctor.match(/export const VERIFIED_CLAUDE_CODE = "([\d.]+)"/)[1];
  for (const track of Object.values(TRACKS)) {
    if (!fs.existsSync(path.join(ROOT, track.resultsFile))) continue;
    assert.equal(JSON.parse(read(track.resultsFile)).environment.claudeCode, verified, track.resultsFile);
  }
});
