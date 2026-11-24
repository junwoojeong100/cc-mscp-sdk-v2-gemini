// Shared pieces of the live verification: a clean environment, an observed bridge,
// isolated Claude Code runs, and readers for Claude Code's stream-json output.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchModelFor, PRIMARY_MODELS } from "../../src/model-map.mjs";
import { LITELLM_HOST, LITELLM_VERSION, installedVersion, litellmArgs, litellmEnv, runtimePaths, waitForLitellm } from "../../src/litellm-runtime.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MODELS = PRIMARY_MODELS;
// The npm package the bridge drives (formerly @github/copilot-sdk).
export const COPILOT_SDK_PACKAGE = "@microsoft/copilot-sdk";
export const frontendModel = launchModelFor;
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Variables a verification must not inherit. A Copilot CLI session exports COPILOT_*
// (including COPILOT_CLI_PATH, which would swap the bridge's runtime); the others
// would reroute or reconfigure Claude Code and the bridge.
const INHERITED = /^(COPILOT_|CLAUDE|ANTHROPIC|GHCP_|BRIDGE_|NODE_TEST_CONTEXT$|NODE_OPTIONS$)/;

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!INHERITED.test(key)) env[key] = value;
  // Claude Code's auto-memory lets a model recall a fact from memory instead of from the
  // conversation. A model switch has to be proven on the conversation alone.
  return { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...extra };
}

// The real Claude Code, found the way the launcher finds it (this repo's wrappers are skipped).
export function resolveClaudeBin() {
  const result = spawnSync(
    "bash",
    ["-c", `source "${ROOT}/bin/resolve-claude.sh" && resolve_claude_code_bin "${ROOT}"`],
    { encoding: "utf8", env: cleanEnv() },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Claude Code was not found");
  return result.stdout.trim();
}

export function claudeVersion(claudeBin) {
  const result = spawnSync(claudeBin, ["--version"], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
  return result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// One observed bridge. BRIDGE_VERIFY_OBSERVE adds the diagnostics a verification reads
// (requested effort, the model state the SDK reports); they carry no prompt text.
export async function startBridge({ workDir, defaultModel = "gemini-4-hydrogen", env: extraEnv = {} }) {
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("hex");
  const logs = [];
  const child = spawn(process.execPath, [path.join(ROOT, "src/server.mjs")], {
    env: cleanEnv({
      HOST: "127.0.0.1",
      PORT: String(port),
      BRIDGE_API_KEY: token,
      GHCP_MODEL: defaultModel,
      BRIDGE_VERIFY_OBSERVE: "1",
      PENDING_TOOL_WAIT_MS: "30000",
      ...extraEnv,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        logs.push(JSON.parse(line));
      } catch {
        logs.push({ event: "raw", line });
      }
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })).ok) {
        up = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  if (!up) {
    child.kill("SIGKILL");
    throw new Error(`The bridge did not start: ${logs.map((entry) => entry.line ?? entry.event).join(" | ")}`);
  }
  const settings = path.join(workDir, `settings-${port}.json`);
  const written = spawnSync(process.execPath, [path.join(ROOT, "src/write-launch-settings.mjs"), settings, baseUrl, defaultModel], {
    env: cleanEnv({ GHCP_BRIDGE_TOKEN: token }),
    encoding: "utf8",
  });
  if (written.status !== 0) throw new Error(`Launch settings failed: ${written.stderr}`);
  return {
    baseUrl,
    token,
    settings,
    logs,
    mark: () => logs.length,
    since: (index) => logs.slice(index),
    async stop() {
      child.kill("SIGTERM");
      const closed = new Promise((resolve) => child.once("close", resolve));
      const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await closed;
      clearTimeout(killer);
    },
  };
}

const ISOLATION_ARGS = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"];

// LiteLLM in front of an observed bridge: the shipped config and the runtime
// `gemini-litellm setup` installed, on a free port with a key of its own. Its
// requests reach the bridge the way a user's would, so the bridge's events still
// say who was asked and who answered.
export async function startLiteLLM({ workDir, bridge }) {
  const paths = runtimePaths(cleanEnv());
  const installed = installedVersion(paths);
  if (installed !== LITELLM_VERSION) {
    throw new Error(`LiteLLM ${LITELLM_VERSION} is not installed (found ${installed ?? "none"}). Run: gemini-litellm setup`);
  }
  const port = await freePort();
  const masterKey = `sk-${crypto.randomBytes(32).toString("hex")}`;
  const baseUrl = `http://${LITELLM_HOST}:${port}`;
  const log = path.join(workDir, `litellm-${port}.log`);
  const logFd = fs.openSync(log, "w", 0o600);
  const child = spawn(paths.python, litellmArgs({ config: paths.config, port }), {
    cwd: workDir,
    env: litellmEnv({ env: cleanEnv(), bridgeUrl: bridge.baseUrl, bridgeToken: bridge.token, masterKey }),
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  try {
    await waitForLitellm({ baseUrl, masterKey, isAlive: () => child.exitCode === null });
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error.message}\n${fs.readFileSync(log, "utf8").split("\n").slice(-20).join("\n")}`);
  }
  const settings = path.join(workDir, `litellm-settings-${port}.json`);
  const written = spawnSync(process.execPath, [path.join(ROOT, "src/write-litellm-settings.mjs"), settings, baseUrl, "gemini-4-hydrogen"], {
    env: cleanEnv({ LITELLM_API_KEY: masterKey }),
    encoding: "utf8",
  });
  if (written.status !== 0) {
    child.kill("SIGKILL");
    throw new Error(`LiteLLM settings failed: ${written.stderr}`);
  }
  return {
    baseUrl,
    port,
    masterKey,
    settings,
    log,
    version: installed,
    async stop() {
      child.kill("SIGTERM");
      const closed = new Promise((resolve) => child.once("close", resolve));
      const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await closed;
      clearTimeout(killer);
    },
  };
}

// One Claude Code print-mode turn against an endpoint (the observed bridge, or LiteLLM
// in front of it), with its own config directory so nothing in the user's Claude Code
// setup is read or changed. `endpoint.settings` is the Claude Code settings file;
// `modelName` is the model name Claude Code is started with.
export function runClaude(endpoint, { claudeBin, configDir, model, modelName = frontendModel(model), cwd, prompt, args = [], timeoutMs = 240_000 }) {
  fs.mkdirSync(configDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(
      claudeBin,
      [
        "--settings", endpoint.settings,
        "--model", modelName,
        "--setting-sources", "",
        ...ISOLATION_ARGS,
        "--output-format", "stream-json",
        "--verbose",
        ...args,
        "-p",
      ],
      {
        cwd,
        env: cleanEnv({ CLAUDE_CONFIG_DIR: configDir, CI: "1", FORCE_COLOR: "0", DISABLE_AUTOUPDATER: "1" }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const startedAt = Date.now();
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = stdout.split("\n").filter((line) => line.trim()).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      resolve(new ClaudeRun({ code, stderr, events, timedOut, durationMs: Date.now() - startedAt }));
    });
    child.stdin.end(prompt);
  });
}

export class ClaudeRun {
  constructor({ code, stderr, events, timedOut, durationMs }) {
    Object.assign(this, { code, stderr, events, timedOut, durationMs });
  }

  get init() {
    return this.events.find((event) => event.type === "system" && event.subtype === "init");
  }

  get result() {
    return this.events.find((event) => event.type === "result");
  }

  get text() {
    return (this.result?.result ?? "").trim();
  }

  get ok() {
    return this.code === 0 && !this.timedOut && this.result?.is_error === false;
  }

  get sessionId() {
    return this.result?.session_id ?? this.init?.session_id ?? null;
  }

  // Tool calls in the order the model made them, each with the result Claude Code returned.
  get toolCalls() {
    const results = new Map();
    for (const event of this.events) {
      if (event.type !== "user" || !Array.isArray(event.message?.content)) continue;
      for (const block of event.message.content) {
        if (block.type === "tool_result") results.set(block.tool_use_id, block);
      }
    }
    return this.events
      .filter((event) => event.type === "assistant" && event.parent_tool_use_id == null)
      .flatMap((event) => event.message.content.filter((block) => block.type === "tool_use"))
      .map((block) => {
        const result = results.get(block.id);
        const content = Array.isArray(result?.content)
          ? result.content.map((part) => part.text ?? "").join("\n")
          : String(result?.content ?? "");
        return { name: block.name, input: block.input, isError: Boolean(result?.is_error), output: content };
      });
  }
}

// Bridge events of one kind, for the window since `mark()`.
export const turnsOf = (events) => events.filter((event) => event.event === "bridge.turn_completed");
export const failuresOf = (events) => events.filter((event) => event.event === "bridge.request_failed");

export function makeWorkspace(root, name, fixtureDir = null) {
  const dir = fs.mkdirSync(path.join(root, name), { recursive: true }) && fs.realpathSync(path.join(root, name));
  if (fixtureDir) fs.cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

export function tempRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
