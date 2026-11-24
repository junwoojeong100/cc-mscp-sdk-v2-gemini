import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCopilotHome } from "./copilot-home.mjs";
import { PRIMARY_MODELS } from "./model-map.mjs";
import { supportedNodeVersion, versionAtLeast } from "./version.mjs";

const json = process.argv.includes("--json");
// The Claude Code version the published verification (verification/results.json) ran on.
export const VERIFIED_CLAUDE_CODE = "2.1.331";
const results = [];

function add(status, name, detail = "") {
  results.push({ status, name, detail });
}

// Bounded: a version probe that hangs must not hang the whole report. SIGKILL,
// because spawnSync waits for the child to exit after its timeout signal.
function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 });
  const text = result.status === 0 ? (result.stdout.trim() || result.stderr.trim()).split("\n")[0] : null;
  return { ok: result.status === 0, version: text };
}

const node = process.versions.node;
add(
  supportedNodeVersion(node) ? "ok" : "fail",
  `Node.js v${node}`,
  supportedNodeVersion(node) ? "" : "needs ^20.19.0 or >=22.12.0",
);

const npm = commandVersion("npm");
add(npm.ok ? "ok" : "fail", `npm ${npm.version ?? ""}`.trim(), npm.ok ? "" : "npm was not found");

const claudeBin = process.env.CLAUDE_CODE_BIN || "claude";
const claude = commandVersion(claudeBin);
const claudeVersion = claude.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? claude.version;
if (!claude.ok) {
  add("fail", "Claude Code", "not found: install it, or set CLAUDE_CODE_BIN to its path");
} else if (versionAtLeast(claudeVersion, VERIFIED_CLAUDE_CODE)) {
  add("ok", `Claude Code ${claudeVersion}`, `${claudeBin}`);
} else {
  add("warn", `Claude Code ${claudeVersion}`, `this lab was verified on ${VERIFIED_CLAUDE_CODE}; older versions may not list the Gemini models in /model`);
}

const copilot = commandVersion("copilot");
add(
  copilot.ok ? "ok" : "fail",
  copilot.ok ? `Copilot CLI ${copilot.version.replace(/^GitHub Copilot CLI\s*/i, "").replace(/\.$/, "")}` : "Copilot CLI",
  copilot.ok ? "" : "not found: npm install -g @github/copilot",
);

if (process.env.COPILOT_CLI_PATH) {
  add(
    "warn",
    "COPILOT_CLI_PATH is set",
    `the bridge would run ${process.env.COPILOT_CLI_PATH} instead of the SDK runtime (usually inherited when started from inside a Copilot CLI session; unset it)`,
  );
}

// A model picked with Enter in /model is saved as the user-wide default, which a plain `claude` cannot serve.
const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
try {
  const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  if (typeof saved.model === "string" && saved.model.startsWith("github-copilot/")) {
    add(
      "warn",
      "Claude Code default model is a Copilot model",
      `"model": "${saved.model}" in ${settingsFile} -- a plain \`claude\` cannot use it; remove that line, and press "s" in /model`,
    );
  }
} catch {
  // No readable settings file: nothing to check.
}

let createClient = null;
try {
  ({ createCopilotClient: createClient } = await import("./copilot-client.mjs"));
} catch {
  add("fail", "Microsoft Copilot SDK", "dependencies are missing: run npm ci in this folder");
}

if (createClient) {
  const client = createClient({
    baseDirectory: resolveCopilotHome(process.env.COPILOT_HOME),
    logLevel: "error",
  });
  let timer;
  try {
    const catalog = await Promise.race([
      (async () => {
        await client.start();
        const status = await client.getStatus();
        const auth = await client.getAuthStatus();
        const models = auth.isAuthenticated ? await client.listModels() : [];
        return { status, auth, models };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("the Copilot runtime did not answer within 90 s")), 90_000);
      }),
    ]);
    add("ok", `Microsoft Copilot SDK (runtime ${catalog.status.version})`);
    if (catalog.auth.isAuthenticated) {
      add("ok", `Copilot sign-in: ${catalog.auth.login}`, catalog.auth.host);
      for (const id of PRIMARY_MODELS) {
        const model = catalog.models.find((entry) => entry.id === id);
        if (!model) {
          add("fail", id, "not in this account's catalog (a plan or organization policy may hide it)");
        } else if (model.policy && model.policy.state !== "enabled") {
          add("fail", id, `policy is ${model.policy.state}: enable it in GitHub Copilot settings`);
        } else {
          const note = (model.infoMessages ?? []).map((info) => info.message).join(" ");
          const warning = (model.warningMessages ?? []).map((item) => item.message).join(" ");
          // Advisory only: the service says the model stays usable.
          add(warning ? "warn" : "ok", id, [note, warning].filter(Boolean).join(" "));
        }
      }
    } else {
      add("fail", "Copilot sign-in", "not signed in: run copilot login");
    }
  } catch (error) {
    add("fail", "GitHub Copilot runtime", error.message);
  } finally {
    clearTimeout(timer);
    await client.stop().catch(() => {});
  }
}

// `gemini-doctor --litellm` also checks what the LiteLLM path needs: uv to install
// it, the installed version, the master key, and the gateway itself.
if (process.argv.includes("--litellm")) {
  const { LITELLM_VERSION, gatewayStatus, installedVersion, runtimePaths } = await import("./litellm-runtime.mjs");
  const paths = runtimePaths();
  const uv = commandVersion("uv");
  add(uv.ok ? "ok" : "warn", `uv ${uv.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? ""}`.trim(), uv.ok ? "" : "gemini-litellm setup needs it: https://docs.astral.sh/uv/");
  const installed = installedVersion(paths);
  if (installed === LITELLM_VERSION) {
    add("ok", `LiteLLM ${installed}`);
  } else if (installed) {
    add("warn", `LiteLLM ${installed}`, `this lab pins ${LITELLM_VERSION}: run gemini-litellm setup`);
  } else {
    add("fail", "LiteLLM", "not installed: run gemini-litellm setup");
  }
  try {
    const mode = fs.statSync(paths.key).mode & 0o777;
    add(mode === 0o600 ? "ok" : "warn", "LiteLLM master key", mode === 0o600 ? "" : `${paths.key} has mode ${mode.toString(8)}; it should be 600`);
  } catch {
    add("fail", "LiteLLM master key", "missing: run gemini-litellm setup");
  }
  const gateway = await gatewayStatus();
  if (gateway.litellm.running && gateway.bridge.running && gateway.inSync) {
    add("ok", "LiteLLM gateway", `running at ${gateway.litellm.url}`);
  } else {
    // Stopped is the normal state before `gemini-litellm up`.
    add("warn", "LiteLLM gateway", "not running: start it with gemini-litellm up");
  }
}

const failed = results.some((result) => result.status === "fail");
if (json) {
  console.log(JSON.stringify({ ok: !failed, results }, null, 2));
} else {
  const mark = { ok: "✓", warn: "!", fail: "✗" };
  for (const { status, name, detail } of results) {
    console.log(`${mark[status]} ${name}${detail ? `  (${detail})` : ""}`);
  }
  const next = process.argv.includes("--litellm") ? "run gemini-litellm up, then claude-gemini-litellm" : "run ./bin/claude-gemini";
  console.log(failed ? "\nFix the ✗ items above, then run this check again." : `\nReady: ${next}`);
}
if (failed) process.exitCode = 1;
