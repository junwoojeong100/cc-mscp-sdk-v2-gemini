import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LITELLM_VERSION, litellmArgs, litellmEnv, litellmModels, readMasterKey, runtimePaths, waitForLitellm,
} from "../src/litellm-runtime.mjs";
import { PRIMARY_MODELS } from "../src/model-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk-test-key";

// A stand-in for LiteLLM's two endpoints the lab uses.
function fakeLitellm(ids = PRIMARY_MODELS) {
  const server = http.createServer((request, response) => {
    if (request.url === "/health/liveliness") return response.end('"I\'m alive!"');
    if (request.url === "/v1/models") {
      if (request.headers.authorization !== `Bearer ${KEY}`) {
        response.writeHead(401).end("{}");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
  }));
}

test("LiteLLM runs as a module of the venv's python, wherever the folder is called", () => {
  const paths = runtimePaths({ GEMINI_LITELLM_HOME: "/somewhere/else" });
  assert.equal(paths.home, "/somewhere/else");
  assert.equal(paths.python, "/somewhere/else/litellm-venv/bin/python");
  // Not the venv's `litellm` script: its shebang holds the absolute path of the folder it was made in.
  assert.deepEqual(litellmArgs({ config: "c.yaml", port: 4001 }).slice(0, 2), ["-m", "litellm.proxy.proxy_cli"]);
  assert.deepEqual(litellmArgs({ config: "c.yaml", port: 4001 }).slice(2), [
    "--config", "c.yaml", "--host", "127.0.0.1", "--port", "4001", "--telemetry", "False",
  ]);
});

test("LiteLLM does not inherit credentials or settings meant for other tools", () => {
  const env = litellmEnv({
    env: {
      PATH: "/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "a", CLAUDE_CODE_BIN: "c", COPILOT_CLI_PATH: "p",
      GHCP_MODEL: "m", BRIDGE_API_KEY: "b", LITELLM_LOG: "DEBUG", OPENAI_API_KEY: "o", AZURE_API_KEY: "z",
    },
    bridgeUrl: "http://127.0.0.1:1", bridgeToken: "token", masterKey: "master",
  });
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_BIN", "COPILOT_CLI_PATH", "GHCP_MODEL", "BRIDGE_API_KEY", "LITELLM_LOG", "OPENAI_API_KEY", "AZURE_API_KEY"]) {
    assert.equal(name in env, false, name);
  }
  assert.equal(env.PATH, "/bin");
  assert.equal(env.GHCP_BRIDGE_URL, "http://127.0.0.1:1");
  assert.equal(env.GHCP_BRIDGE_TOKEN, "token");
  assert.equal(env.LITELLM_MASTER_KEY, "master");
});

test("the master key comes from its file, and a missing one says how to create it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "litellm-key-"));
  const paths = runtimePaths({ GEMINI_LITELLM_HOME: home });
  assert.throws(() => readMasterKey(paths), /gemini-litellm setup/);
  fs.writeFileSync(paths.key, `${KEY}\n`);
  assert.equal(readMasterKey(paths), KEY);
});

test("the gateway is ready only when it answers and serves every Gemini 4 alias", async () => {
  const gateway = await fakeLitellm();
  try {
    assert.equal((await litellmModels(gateway.url, KEY)).ok, true);
    assert.equal((await litellmModels(gateway.url, "wrong")).status, 401);
    assert.equal((await litellmModels("http://127.0.0.1:1", KEY)).status, 0);
    const ids = await waitForLitellm({ baseUrl: gateway.url, masterKey: KEY, isAlive: () => true, timeoutMs: 5_000 });
    assert.deepEqual(ids, [...PRIMARY_MODELS]);
    await assert.rejects(waitForLitellm({ baseUrl: gateway.url, masterKey: KEY, isAlive: () => false }), /exited while starting/);
  } finally {
    await gateway.close();
  }
  const partial = await fakeLitellm(["gemini-4-neon"]);
  try {
    await assert.rejects(waitForLitellm({ baseUrl: partial.url, masterKey: KEY, isAlive: () => true, timeoutMs: 900 }), /did not become ready/);
  } finally {
    await partial.close();
  }
});

test("the shipped config serves the four aliases through the bridge, authenticated by header, and forwards Claude Code's headers", () => {
  const config = fs.readFileSync(path.join(ROOT, "examples/litellm-gemini.yaml"), "utf8");
  assert.deepEqual([...config.matchAll(/^\s*- model_name: (\S+)$/gm)].map((match) => match[1]), [...PRIMARY_MODELS]);
  for (const id of PRIMARY_MODELS) assert.match(config, new RegExp(`model: anthropic/${id}$`, "m"));
  assert.equal([...config.matchAll(/^\s*api_base: os\.environ\/GHCP_BRIDGE_URL$/gm)].length, PRIMARY_MODELS.length);
  assert.equal([...config.matchAll(/^\s+x-api-key: os\.environ\/GHCP_BRIDGE_TOKEN$/gm)].length, PRIMARY_MODELS.length);
  // With an api_key, LiteLLM answers Claude Code's /v1/messages/count_tokens by posting the whole
  // conversation and that key to api.anthropic.com. Without one it counts locally.
  assert.doesNotMatch(config, /^\s*api_key:/m);
  assert.match(config, /^\s*forward_client_headers_to_llm_api: true$/m);
  // That separate setting would override the bridge token with the client's key.
  assert.doesNotMatch(config, /^\s*forward_llm_provider_auth_headers:/m);
  assert.match(config, /supports_adaptive_thinking: true/);
});

test("the setup script installs exactly the version the gateway checks, by hash, for every platform", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts/setup-litellm.sh"), "utf8");
  assert.equal(script.match(/^LITELLM_VERSION="([^"]+)"$/m)[1], LITELLM_VERSION);
  assert.equal([...script.matchAll(/WHEEL_SHA256="[0-9a-f]{64}"/g)].length, 4);
  assert.match(script, /--require-hashes/);
  assert.equal(spawnSync("bash", ["-n", path.join(ROOT, "scripts/setup-litellm.sh")]).status, 0);
});

// Async, because the stand-in gateway runs in this process: a blocking spawn would starve it.
function execute(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const writeSettings = (output, baseUrl, model, env = { LITELLM_API_KEY: KEY }) => execute(
  process.execPath, [path.join(ROOT, "src/write-litellm-settings.mjs"), output, baseUrl, model], env,
);

test("the settings point Claude Code at LiteLLM with its key, and list only what the gateway serves", async () => {
  const gateway = await fakeLitellm();
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "litellm-settings-")), "settings.json");
  try {
    const result = await writeSettings(output, `${gateway.url}/`, "gemini-4-neon");
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, gateway.url);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, KEY);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(settings.modelPicker.options.map((option) => option.model), [...PRIMARY_MODELS]);
    assert.ok(settings.modelPicker.options.every((option) => option.label.startsWith("LiteLLM · ")));
  } finally {
    await gateway.close();
  }
});

test("the settings are refused, with the reason, when the gateway cannot serve the session", async () => {
  const gateway = await fakeLitellm(["gemini-4-neon"]);
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "litellm-settings-")), "settings.json");
  try {
    assert.match((await writeSettings(output, gateway.url, "gemini-4-argon")).stderr, /does not serve "gemini-4-argon"/);
    assert.match((await writeSettings(output, gateway.url, "gemini-4-neon", { LITELLM_API_KEY: "wrong" })).stderr, /rejected the key/);
    assert.match((await writeSettings(output, "http://127.0.0.1:1", "gemini-4-neon")).stderr, /Cannot reach LiteLLM/);
    assert.equal((await writeSettings(output, `${gateway.url}/v1`, "gemini-4-neon")).status, 2);
    assert.equal((await writeSettings(output, gateway.url, "gemini-4-neon", {})).status, 2);
    assert.equal(fs.existsSync(output), false);
  } finally {
    await gateway.close();
  }
});

// The launcher starts the Claude Code named by CLAUDE_CODE_BIN; this one records how it was started.
function standInClaude(directory) {
  const file = path.join(directory, "claude");
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const settingsPath = process.argv[process.argv.indexOf("--settings") + 1];
fs.writeFileSync(${JSON.stringify(path.join(directory, "seen.json"))}, JSON.stringify({ argv: process.argv.slice(2), settingsPath, settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")) }));
`, { mode: 0o755 });
  return file;
}

const launcher = (args, env) => execute(path.join(ROOT, "bin/claude-gemini-litellm"), args, env);

test("claude-gemini-litellm starts Claude Code on the chosen alias with settings that are gone after print mode", async () => {
  const gateway = await fakeLitellm();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "litellm-launcher-"));
  try {
    const result = await launcher(["--litellm-model", "gemini-4-neon", "-p", "hello"], {
      CLAUDE_CODE_BIN: standInClaude(directory), LITELLM_BASE_URL: gateway.url, LITELLM_API_KEY: KEY, GEMINI_LITELLM_HOME: path.join(directory, "runtime"),
    });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(fs.readFileSync(path.join(directory, "seen.json"), "utf8"));
    assert.deepEqual(seen.argv, ["--settings", seen.settingsPath, "--model", "gemini-4-neon", "-p", "hello"]);
    assert.equal(seen.settings.env.ANTHROPIC_BASE_URL, gateway.url);
    assert.equal(fs.existsSync(seen.settingsPath), false, "the settings file holds the key, so print mode removes it");
  } finally {
    await gateway.close();
  }
});

test("claude-gemini-litellm refuses what would make the route ambiguous", async () => {
  const refused = [
    [["--model", "x"], /--litellm-model/],
    [["--settings", "x"], /--settings is not supported/],
    [["--ghcp-model", "gemini-4-neon"], /direct launcher/],
    [["--litellm-model"], /requires a value/],
  ];
  for (const [args, message] of refused) {
    const result = await launcher(args, { LITELLM_API_KEY: KEY });
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
  }
  const noKey = await launcher([], { GEMINI_LITELLM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "litellm-nokey-")) });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /LITELLM_API_KEY is required/);
});
