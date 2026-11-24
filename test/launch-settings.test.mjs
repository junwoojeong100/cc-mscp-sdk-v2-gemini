import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FAMILY_MODELS, PRIMARY_MODELS, launchModelFor } from "../src/model-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "src/write-launch-settings.mjs");
const TOKEN = "test-token-0123456789";

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// A bridge that answers /v1/models?all=true for the models it is given, and only to its token.
async function withBridge(modelIds, body) {
  const server = http.createServer((req, res) => {
    const authorized = req.headers["x-api-key"] === TOKEN;
    if (authorized && req.url === "/v1/models?all=true") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id })) }));
    } else {
      res.writeHead(401).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "launch-settings-")), "nested", "settings.json");
}

test("the picker lists only the Gemini 4 models the bridge reports, and the settings point at the bridge", async () => {
  const out = tempFile();
  await withBridge(["gemini-4-carbon", "gemini-4-neon", "gemini-4-hydrogen", "gpt-6-sol"], async (baseUrl) => {
    const result = await run([out, baseUrl, "gemini-4-neon"], { GHCP_BRIDGE_TOKEN: TOKEN });
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(settings.modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(settings.modelPicker.options.map((option) => option.model),
      ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"].map(launchModelFor));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, baseUrl);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, TOKEN);
    assert.equal(settings.env.ANTHROPIC_API_KEY, "");
    assert.equal(settings.env.ANTHROPIC_MODEL, launchModelFor("gemini-4-neon"));
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  });
});

test("Claude Code's own aliases are pinned to Gemini 4 models and provider selectors are blanked", async () => {
  const out = tempFile();
  await withBridge(PRIMARY_MODELS, async (baseUrl) => {
    await run([out, baseUrl, "gemini-4-argon"], { GHCP_BRIDGE_TOKEN: TOKEN });
    const { env } = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, launchModelFor(FAMILY_MODELS.opus));
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, launchModelFor(FAMILY_MODELS.sonnet));
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, launchModelFor(FAMILY_MODELS.haiku));
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, launchModelFor(FAMILY_MODELS.haiku));
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GitHub Copilot Gemini 4 Neon");
    for (const name of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_DEFAULT_MODEL"]) {
      assert.equal(env[name], "", name);
    }
    assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
    assert.equal(env.ENABLE_TOOL_SEARCH, "");
  });
});

test("a model outside the alias family is the custom option and pins subagents; a family model does not", async () => {
  await withBridge(PRIMARY_MODELS, async (baseUrl) => {
    const outside = tempFile();
    await run([outside, baseUrl, "gemini-4-argon"], { GHCP_BRIDGE_TOKEN: TOKEN });
    const argon = JSON.parse(fs.readFileSync(outside, "utf8")).env;
    assert.equal(argon.ANTHROPIC_CUSTOM_MODEL_OPTION, launchModelFor("gemini-4-argon"));
    assert.equal(argon.CLAUDE_CODE_SUBAGENT_MODEL, launchModelFor("gemini-4-argon"));
    assert.equal(argon.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP, "1");

    const inside = tempFile();
    await run([inside, baseUrl, "gemini-4-neon"], { GHCP_BRIDGE_TOKEN: TOKEN });
    const neon = JSON.parse(fs.readFileSync(inside, "utf8")).env;
    assert.equal(neon.ANTHROPIC_CUSTOM_MODEL_OPTION, "");
    assert.equal(neon.CLAUDE_CODE_SUBAGENT_MODEL, "");
    assert.equal(neon.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP, "1");
  });
});

test("when the bridge cannot be reached, the picker lists all four models", async () => {
  const out = tempFile();
  const result = await run([out, "http://127.0.0.1:9", "gemini-4-hydrogen"], { GHCP_BRIDGE_TOKEN: TOKEN });
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(settings.modelPicker.options.length, 4);
});

test("the bridge token is accepted only from the environment", async () => {
  const out = tempFile();
  const missing = await run([out, "http://127.0.0.1:9", "gemini-4-neon"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage/);
  const viaArgv = await run([out, "http://127.0.0.1:9", "gemini-4-neon", TOKEN], { GHCP_BRIDGE_TOKEN: TOKEN });
  assert.equal(viaArgv.status, 2);
  assert.ok(!viaArgv.stderr.includes(TOKEN) && !viaArgv.stdout.includes(TOKEN));
  assert.equal(fs.existsSync(out), false);
});

test("native tool search is off unless asked for, and only 0 or 1 is accepted", async () => {
  await withBridge(PRIMARY_MODELS, async (baseUrl) => {
    const on = tempFile();
    await run([on, baseUrl, "gemini-4-neon"], { GHCP_BRIDGE_TOKEN: TOKEN, GHCP_NATIVE_TOOL_SEARCH: "1" });
    assert.equal(JSON.parse(fs.readFileSync(on, "utf8")).env.ENABLE_TOOL_SEARCH, "true");
    const bad = await run([tempFile(), baseUrl, "gemini-4-neon"], { GHCP_BRIDGE_TOKEN: TOKEN, GHCP_NATIVE_TOOL_SEARCH: "2" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /GHCP_NATIVE_TOOL_SEARCH must be 0 or 1/);
  });
});
