import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { daemonPaths, readDaemonRegistry } from "./bridge-daemon.mjs";
import { PRIMARY_MODELS } from "./model-map.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LITELLM_HOST = "127.0.0.1";
export const DEFAULT_LITELLM_PORT = 4000;
// scripts/setup-litellm.sh installs exactly this version.
export const LITELLM_VERSION = "1.97.0";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything the gateway installs, runs and writes lives under one directory
// (git-ignored .runtime/ unless GEMINI_LITELLM_HOME says otherwise). The gateway
// runs its own bridge daemon in `bridge`, so it never shares a bridge with
// `claude-gemini` and neither can replace the other's.
export function runtimePaths(env = process.env) {
  const home = path.resolve(env.GEMINI_LITELLM_HOME || path.join(ROOT, ".runtime"));
  return {
    home,
    python: path.join(home, "litellm-venv", "bin", "python"),
    key: path.join(home, "litellm-master-key"),
    log: path.join(home, "litellm.log"),
    state: path.join(home, "litellm.json"),
    bridge: path.join(home, "bridge"),
    settings: path.join(home, "settings"),
    config: path.join(ROOT, "examples", "litellm-gemini.yaml"),
  };
}

export function readMasterKey(paths) {
  let key = "";
  try {
    key = fs.readFileSync(paths.key, "utf8").trim();
  } catch {
    // Reported below.
  }
  if (!key) throw new Error("The LiteLLM master key is missing. Run: gemini-litellm setup");
  return key;
}

export function installedVersion(paths) {
  if (!fs.existsSync(paths.python)) return null;
  const result = spawnSync(paths.python, ["-c", "import importlib.metadata as m; print(m.version('litellm'))"], { encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

const NOT_FOR_LITELLM = /^(ANTHROPIC_|CLAUDE|COPILOT_|GHCP_|BRIDGE_|LITELLM_|OPENAI_|AZURE_)/;

// The environment LiteLLM runs with. The config reads the bridge's URL and token
// from it (os.environ/ values are read once, when LiteLLM loads the file).
export function litellmEnv({ env = process.env, bridgeUrl, bridgeToken, masterKey }) {
  const inherited = Object.fromEntries(Object.entries(env).filter(([name]) => !NOT_FOR_LITELLM.test(name)));
  return {
    ...inherited,
    GHCP_BRIDGE_URL: bridgeUrl,
    GHCP_BRIDGE_TOKEN: bridgeToken,
    LITELLM_MASTER_KEY: masterKey,
    // The bundled price list instead of one fetched at start-up, no admin UI, and no
    // .env file picked up from the working directory.
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    DISABLE_ADMIN_UI: "True",
    LITELLM_MODE: "PRODUCTION",
    PYTHONUNBUFFERED: "1",
  };
}

// Arguments for the venv's python. LiteLLM is started as a module, not through
// the venv's `litellm` script: that script's first line is the absolute path of
// the folder the venv was made in, so it breaks when the folder is renamed.
export const litellmArgs = ({ config, host = LITELLM_HOST, port }) => [
  "-m", "litellm.proxy.proxy_cli", "--config", config, "--host", host, "--port", String(port), "--telemetry", "False",
];

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A recorded pid is only trusted while it is still a LiteLLM process.
export function isLitellmProcess(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && /litellm/.test(result.stdout);
}

export function readState(paths) {
  try {
    const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
    return Number.isSafeInteger(state.pid) && Number.isSafeInteger(state.port) ? state : null;
  } catch {
    return null;
  }
}

export async function liveliness(baseUrl, timeoutMs = 3_000) {
  try {
    return (await fetch(new URL("/health/liveliness", baseUrl), { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

// What the gateway answers for GET /v1/models: ok with the aliases it serves, or
// why not (`status` 401 is a wrong key, 0 is no connection).
export async function litellmModels(baseUrl, key, { timeoutMs = 5_000 } = {}) {
  try {
    const response = await fetch(new URL("/v1/models", baseUrl), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, status: response.status, ids: [] };
    return { ok: true, status: response.status, ids: (await response.json()).data.map((entry) => entry.id) };
  } catch (error) {
    return { ok: false, status: 0, ids: [], error: error.cause?.code ?? error.message };
  }
}

// Waits until LiteLLM answers and serves every Gemini 4 alias.
export async function waitForLitellm({ baseUrl, masterKey, isAlive, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error("LiteLLM exited while starting.");
    if (await liveliness(baseUrl, 2_000)) {
      const models = await litellmModels(baseUrl, masterKey, { timeoutMs: 3_000 });
      if (models.ok && PRIMARY_MODELS.every((id) => models.ids.includes(id))) return models.ids;
    }
    await sleep(400);
  }
  throw new Error(`LiteLLM did not become ready within ${Math.round(timeoutMs / 1000)} s.`);
}

async function bridgeHealthy(registry) {
  try {
    return (await fetch(`http://127.0.0.1:${registry.port}/health`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
}

// Both layers of the gateway, and whether LiteLLM holds the bridge's current token.
export async function gatewayStatus(env = process.env) {
  const paths = runtimePaths(env);
  const state = readState(paths);
  const registry = readDaemonRegistry(daemonPaths({ ...env, GHCP_DAEMON_DIR: paths.bridge }));
  const bridgeRunning = Boolean(registry && pidAlive(registry.pid) && (await bridgeHealthy(registry)));
  const baseUrl = state ? `http://${state.host ?? LITELLM_HOST}:${state.port}` : null;
  const litellmRunning = Boolean(state && pidAlive(state.pid) && isLitellmProcess(state.pid) && (await liveliness(baseUrl)));
  let models = [];
  if (litellmRunning) {
    try {
      models = (await litellmModels(baseUrl, readMasterKey(paths))).ids;
    } catch {
      models = [];
    }
  }
  return {
    installed: installedVersion(paths),
    bridge: {
      running: bridgeRunning,
      pid: bridgeRunning ? registry.pid : null,
      port: bridgeRunning ? registry.port : null,
      model: bridgeRunning ? registry.model : null,
    },
    litellm: {
      running: litellmRunning,
      pid: litellmRunning ? state.pid : null,
      port: litellmRunning ? state.port : null,
      url: litellmRunning ? baseUrl : null,
      models,
    },
    inSync: litellmRunning && bridgeRunning && state.bridge?.port === registry.port && state.bridge?.tokenSha256 === sha256(registry.token),
  };
}
