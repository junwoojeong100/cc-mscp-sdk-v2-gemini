#!/usr/bin/env node
// gemini-litellm: LiteLLM in front of the bridge, on this machine.
//
//   Claude Code -> LiteLLM -> bridge (src/server.mjs) -> @microsoft/copilot-sdk -> Gemini 4
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  DEFAULT_LITELLM_PORT, LITELLM_HOST, LITELLM_VERSION, ROOT, gatewayStatus, installedVersion, isLitellmProcess, liveliness, litellmArgs, litellmEnv,
  litellmModels, pidAlive, readMasterKey, readState, runtimePaths, sha256, waitForLitellm,
} from "./litellm-runtime.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paths = runtimePaths();
const ok = (text) => console.log(`✓ ${text}`);
const warn = (text) => console.log(`! ${text}`);

function fail(message, detail = "") {
  console.error(`✗ ${message}`);
  if (detail) console.error(detail.trimEnd());
  process.exit(1);
}

const USAGE = `Usage: gemini-litellm <command>

Commands:
  setup            Install LiteLLM ${LITELLM_VERSION} (pinned) and create its master key, once
  up [options]     Start the bridge and LiteLLM in the background
  status [--json]  Show both layers
  turns            Which model each request asked for and which one served it
  logs [--follow]  LiteLLM's log (--all keeps its start-up warnings)
  down             Stop LiteLLM and the bridge

Options for up:
  --port PORT         LiteLLM port (default ${DEFAULT_LITELLM_PORT}, or LITELLM_PORT)
  --model MODEL       Gemini 4 model the bridge checks at start (default gemini-4-hydrogen)
  --bridge-port PORT  Fixed bridge port (default: a free one)
`;

const nodeCli = (script, args, env) =>
  spawnSync(process.execPath, [path.join(ROOT, "src", script), ...args], { encoding: "utf8", env, timeout: 180_000 });
// The gateway's bridge is its own daemon, apart from the one `claude-gemini` uses.
const bridgeEnv = () => ({ ...process.env, GHCP_DAEMON_DIR: paths.bridge });

const option = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function portOption(value, name) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail(`${name} must be a port number between 1 and 65535.`);
  return port;
}

const portFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen(port, LITELLM_HOST, () => server.close(() => resolve(true)));
});

const tail = (file, count) => fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).slice(-count).join("\n");

async function stopLitellm(state) {
  if (!pidAlive(state.pid) || !isLitellmProcess(state.pid)) return false;
  // LiteLLM runs as the leader of its own process group, so the signal reaches its workers too.
  const signal = (name) => {
    try {
      process.kill(-state.pid, name);
    } catch {
      try {
        process.kill(state.pid, name);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (pidAlive(state.pid) && Date.now() < deadline) await sleep(200);
  if (pidAlive(state.pid)) signal("SIGKILL");
  return true;
}

function masterKeyOrFail() {
  try {
    return readMasterKey(paths);
  } catch (error) {
    return fail(error.message);
  }
}

function setup() {
  const result = spawnSync("bash", [path.join(ROOT, "scripts", "setup-litellm.sh")], {
    stdio: "inherit",
    env: { ...process.env, GEMINI_LITELLM_HOME: paths.home },
  });
  process.exit(result.status ?? 1);
}

async function up(args) {
  if (!installedVersion(paths)) fail("LiteLLM is not installed.", "Run: gemini-litellm setup");
  const masterKey = masterKeyOrFail();
  const port = portOption(option(args, "--port") ?? process.env.LITELLM_PORT ?? String(DEFAULT_LITELLM_PORT), "--port");
  const bridgePort = portOption(option(args, "--bridge-port"), "--bridge-port");
  const model = option(args, "--model") ?? "gemini-4-hydrogen";
  const baseUrl = `http://${LITELLM_HOST}:${port}`;
  if (process.env.COPILOT_CLI_PATH) {
    warn(`COPILOT_CLI_PATH is set: the bridge would run ${process.env.COPILOT_CLI_PATH} instead of the SDK runtime (unset it)`);
  }

  const ensured = nodeCli("bridge-daemon.mjs", ["ensure", model, ...(bridgePort ? [String(bridgePort)] : [])], bridgeEnv());
  if (ensured.status !== 0) fail("The bridge did not start.", ensured.stderr || ensured.stdout);
  const bridge = JSON.parse(ensured.stdout.trim().split("\n").at(-1));
  ok(`Bridge   http://127.0.0.1:${bridge.port}  (pid ${bridge.pid})`);

  // Keep a LiteLLM that was started with this bridge's port and token; start a new
  // one otherwise, because LiteLLM reads the token once, when it loads its config.
  const state = readState(paths);
  const running = Boolean(state && pidAlive(state.pid) && isLitellmProcess(state.pid));
  const current = running && state.port === port && state.bridge?.port === bridge.port &&
    state.bridge?.tokenSha256 === sha256(bridge.token) && (await liveliness(baseUrl));
  let aliases;
  if (current) {
    aliases = (await litellmModels(baseUrl, masterKey)).ids;
    ok(`LiteLLM  ${baseUrl}  (pid ${state.pid}, already running)`);
  } else {
    if (running) await stopLitellm(state);
    fs.rmSync(paths.state, { force: true });
    if (!(await portFree(port))) fail(`Port ${port} is already in use.`, "Choose another one with: gemini-litellm up --port PORT");
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(paths.log, "w", 0o600);
    const child = spawn(paths.python, litellmArgs({ config: paths.config, port }), {
      cwd: paths.home,
      env: litellmEnv({ bridgeUrl: `http://127.0.0.1:${bridge.port}`, bridgeToken: bridge.token, masterKey }),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    fs.writeFileSync(paths.state, `${JSON.stringify({
      pid: child.pid,
      host: LITELLM_HOST,
      port,
      startedAt: new Date().toISOString(),
      version: LITELLM_VERSION,
      bridge: { pid: bridge.pid, port: bridge.port, tokenSha256: sha256(bridge.token) },
    }, null, 2)}\n`, { mode: 0o600 });
    try {
      aliases = await waitForLitellm({ baseUrl, masterKey, isAlive: () => pidAlive(child.pid) });
    } catch (error) {
      await stopLitellm({ pid: child.pid });
      fs.rmSync(paths.state, { force: true });
      fail(error.message, tail(paths.log, 20));
    }
    ok(`LiteLLM  ${baseUrl}  (pid ${child.pid}, v${LITELLM_VERSION})`);
  }
  ok(`Models   ${aliases.join(", ")}`);
  console.log(`\nClaude Code → LiteLLM :${port} → bridge :${bridge.port} → Copilot SDK → Gemini 4`);
  console.log("Next: claude-gemini-litellm");
}

async function status(args) {
  const s = await gatewayStatus();
  const healthy = s.litellm.running && s.bridge.running && s.inSync;
  if (args.includes("--json")) {
    console.log(JSON.stringify(s));
  } else if (!s.installed) {
    console.log("✗ LiteLLM  not installed  (run: gemini-litellm setup)");
  } else {
    const line = (good, text) => console.log(`${good ? "✓" : "✗"} ${text}`);
    line(s.litellm.running, s.litellm.running ? `LiteLLM  running  ${s.litellm.url}  (pid ${s.litellm.pid}, v${s.installed})` : `LiteLLM  stopped  (v${s.installed} is installed)`);
    line(s.bridge.running, s.bridge.running ? `Bridge   running  http://127.0.0.1:${s.bridge.port}  (pid ${s.bridge.pid})` : "Bridge   stopped");
    if (s.litellm.running && s.bridge.running) {
      line(s.inSync, s.inSync ? "Chain    LiteLLM holds the bridge's current token" : "Chain    LiteLLM was started with an older bridge token");
      line(s.litellm.models.length > 0, `Models   ${s.litellm.models.join(", ") || "none"}`);
    }
    if (!healthy) console.log("\nStart it with: gemini-litellm up");
  }
  process.exitCode = healthy ? 0 : 1;
}

function logs(args) {
  if (!fs.existsSync(paths.log)) fail("There is no LiteLLM log yet.", "Start the gateway first: gemini-litellm up");
  if (args.includes("--follow") || args.includes("-f")) {
    spawnSync("tail", ["-n", "40", "-f", paths.log], { stdio: "inherit" });
    return;
  }
  const lines = fs.readFileSync(paths.log, "utf8").split("\n").filter((line) => line.trim());
  const shown = args.includes("--all") ? lines : lines.filter((line) => !/register_model:/.test(line));
  console.log(shown.slice(-20).join("\n"));
}

function turns(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "turns.mjs"), ...args], { stdio: "inherit", env: bridgeEnv() });
  process.exit(result.status ?? 1);
}

async function down() {
  const state = readState(paths);
  const stopped = state ? await stopLitellm(state) : false;
  fs.rmSync(paths.state, { force: true });
  ok(stopped ? "LiteLLM stopped" : "LiteLLM was not running");
  const bridge = nodeCli("bridge-daemon.mjs", ["stop"], bridgeEnv());
  if (bridge.status !== 0) fail("The bridge could not be stopped.", bridge.stderr || bridge.stdout);
  ok(JSON.parse(bridge.stdout.trim().split("\n").at(-1)).stopped ? "Bridge stopped" : "Bridge was not running");
  // The settings files Claude Code was started from hold the LiteLLM key.
  fs.rmSync(paths.settings, { recursive: true, force: true });
}

const [command, ...rest] = process.argv.slice(2);
const commands = { setup, up, status, logs, turns, down };
if (commands[command]) {
  await commands[command](rest);
} else {
  const help = !command || ["help", "-h", "--help"].includes(command);
  (help ? console.log : console.error)(USAGE);
  process.exitCode = help ? 0 : 2;
}
