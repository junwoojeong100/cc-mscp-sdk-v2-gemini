#!/usr/bin/env node
// Live verification of Claude Code on the four Gemini 4 models through the
// Microsoft Copilot SDK. It calls real models: see docs in guide.html for the cost.
//
//   node scripts/verify/run.mjs                      the whole matrix
//   node scripts/verify/run.mjs --via litellm        the same, through the LiteLLM gateway
//   node scripts/verify/run.mjs --dry-run            list the cases, call nothing
//   node scripts/verify/run.mjs --models gemini-4-neon --scenarios answer,coding
//   node scripts/verify/run.mjs --publish            also write the track's results file
//                                                    (verification/results.json, or results-litellm.json)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { COPILOT_SDK_PACKAGE, MODELS, ROOT, claudeVersion, cleanEnv, resolveClaudeBin, runClaude, sha256, startBridge, startLiteLLM, tempRoot } from "./lib.mjs";
import { supportedReasoningEfforts } from "../../src/model-map.mjs";
import { scenariosFor } from "./scenarios.mjs";
import { trackNamed } from "./tracks.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const flag = (name) => args.includes(name);
const list = (name, all) => {
  const value = option(name);
  if (!value) return all;
  const chosen = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = chosen.filter((item) => !all.includes(item));
  if (unknown.length) {
    console.error(`Unknown ${name} value: ${unknown.join(", ")}\nChoose from: ${all.join(", ")}`);
    process.exit(2);
  }
  return chosen;
};

const track = trackNamed(option("--via") ?? "direct");
const available = scenariosFor(track);
const models = list("--models", MODELS);
const scenarios = available.filter((scenario) => list("--scenarios", available.map((item) => item.id)).includes(scenario.id));
const timeoutScale = Number(option("--timeout-scale") ?? 1);
const cases = scenarios.flatMap((scenario) => (scenario.perModel ? models.map((model) => ({ scenario, model })) : [{ scenario, model: null }]));

if (flag("--dry-run")) {
  console.log(`${cases.length} cases on the ${track.id} track (no model is called):`);
  for (const { scenario, model } of cases) console.log(`  ${scenario.id.padEnd(9)} ${model ?? "(all four, one session)"}  ${scenario.title}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+/, "Z");
const outDir = path.resolve(option("--out") ?? path.join(ROOT, ".verify-runs", stamp));
fs.mkdirSync(outDir, { recursive: true });
const root = tempRoot("gemini-verify-");
const scratch = path.join(root, "scratch");
fs.mkdirSync(scratch);

// Files the verification must leave alone: the user's real Claude Code settings.
const guarded = [path.join(os.homedir(), ".claude", "settings.json")];
const digestOf = (file) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : "absent");
const guardBefore = guarded.map(digestOf);

const claudeBin = fs.realpathSync(resolveClaudeBin());
const doctor = spawnSync(process.execPath, [path.join(ROOT, "src/doctor.mjs"), "--json"], { encoding: "utf8", env: cleanEnv({ CLAUDE_CODE_BIN: claudeBin }), timeout: 180_000 });
const preflight = JSON.parse(doctor.stdout || '{"ok":false,"results":[]}');
const sdkVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", COPILOT_SDK_PACKAGE, "package.json"), "utf8")).version;
const runtime = preflight.results.find((item) => item.name.startsWith("Microsoft Copilot SDK"))?.name.match(/runtime ([\d.]+)/)?.[1] ?? null;
const signedIn = preflight.results.some((item) => item.name.startsWith("Copilot sign-in"));
console.log(`Claude Code ${claudeVersion(claudeBin)} | Node ${process.version} | Copilot SDK ${sdkVersion} (runtime ${runtime}) | signed in: ${signedIn}`);
if (!preflight.ok) {
  console.error("Preflight failed:\n" + preflight.results.filter((item) => item.status === "fail").map((item) => `  ✗ ${item.name} ${item.detail}`).join("\n"));
  process.exit(1);
}

const startedAt = new Date();
const catalogRun = spawnSync(process.execPath, [path.join(ROOT, "src/list-models.mjs"), "--json"], { encoding: "utf8", env: cleanEnv(), timeout: 120_000 });
const catalog = Object.fromEntries(JSON.parse(catalogRun.stdout || "[]").map((model) => [model.id, model]));
const bridge = await startBridge({ workDir: root });
// The endpoint Claude Code talks to: the observed bridge, or LiteLLM in front of it.
let litellm = null;
if (track.id === "litellm") {
  try {
    litellm = await startLiteLLM({ workDir: root, bridge });
  } catch (error) {
    await bridge.stop();
    console.error(`Could not start LiteLLM: ${error.message}`);
    process.exit(1);
  }
  console.log(`LiteLLM ${litellm.version} on ${litellm.baseUrl} in front of the bridge`);
}
const endpoint = litellm ?? bridge;
const configDir = path.join(root, "claude-config");
const ctx = {
  root,
  scratch,
  bridge,
  litellm,
  track,
  catalog,
  claudeBin,
  timeoutScale,
  claude: (options) => runClaude(endpoint, { claudeBin, configDir, modelName: track.clientModel(options.model), ...options, timeoutMs: (options.timeoutMs ?? 240_000) * timeoutScale }),
};

const results = [];
try {
  for (const { scenario, model } of cases) {
    const label = `${scenario.id}${model ? ` / ${model}` : ""}`;
    const began = Date.now();
    let outcome;
    try {
      outcome = await scenario.run(ctx, model);
    } catch (error) {
      outcome = { checks: { items: [{ name: "the scenario ran to the end", ok: false, detail: error.stack ?? error.message }], ok: false }, facts: {} };
    }
    const checks = outcome.checks.items;
    const ok = outcome.checks.ok;
    results.push({ scenario: scenario.id, model, ok, seconds: Math.round((Date.now() - began) / 100) / 10, checks, facts: outcome.facts });
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${((Date.now() - began) / 1000).toFixed(1)}s  (${checks.filter((check) => check.ok).length}/${checks.length} checks)`);
    for (const check of checks.filter((item) => !item.ok)) console.log(`        ✗ ${check.name}: ${check.detail}`);
  }
} finally {
  await litellm?.stop();
  await bridge.stop();
}

// Facts about the whole run, not about one case.
const invariants = [];
const processes = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n");
const leftovers = processes.filter((line) => line.includes(`${ROOT}/src/server.mjs`));
invariants.push({ name: "no bridge process is left running", ok: leftovers.length === 0, detail: leftovers.join(" | ") });
if (litellm) {
  const gateways = processes.filter((line) => line.includes("litellm.proxy.proxy_cli") && line.includes(`--port ${litellm.port}`));
  invariants.push({ name: "no LiteLLM process is left running", ok: gateways.length === 0, detail: gateways.join(" | ") });
}
guarded.forEach((file, index) => {
  invariants.push({ name: `${file.replace(os.homedir(), "~")} was not touched`, ok: guardBefore[index] === digestOf(file), detail: "its contents changed during the run" });
});
// Claude Code names a project folder after the working directory, so a run that
// escaped its private config directory would leave one for these temp folders.
const realProjects = path.join(os.homedir(), ".claude", "projects");
const leakedProjects = fs.existsSync(realProjects)
  ? fs.readdirSync(realProjects).filter((name) => name.includes(path.basename(root)))
  : [];
invariants.push({ name: "no session was written to the real ~/.claude/projects", ok: leakedProjects.length === 0, detail: leakedProjects.join(", ") });
for (const item of invariants) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok ? "" : `: ${item.detail}`}`);

const allChecks = results.flatMap((result) => result.checks);
const summary = {
  cases: results.length,
  passed: results.filter((result) => result.ok).length,
  checks: allChecks.length,
  checksPassed: allChecks.filter((check) => check.ok).length,
  invariantsOk: invariants.every((item) => item.ok),
  // Requests the bridge answered with an upstream overload (an empty Gemini response) that Claude Code retried.
  upstreamRetries: results.reduce((sum, result) => sum + (result.facts?.upstreamRetries ?? 0), 0),
};
const report = {
  schema: 1,
  track: track.id,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  environment: {
    claudeCode: claudeVersion(claudeBin),
    node: process.version,
    copilotSdkPackage: COPILOT_SDK_PACKAGE,
    copilotSdk: sdkVersion,
    copilotRuntime: runtime,
    ...(litellm ? { litellm: litellm.version } : {}),
    platform: `${process.platform} ${process.arch}`,
    copilotAuth: "signed in with a user account (login not recorded)",
    timeoutScale,
    // What the Copilot catalog said about each model when this ran.
    catalog: models.map((id) => {
      const model = catalog[id];
      const limits = model?.capabilities?.limits ?? {};
      return {
        id,
        name: model?.name ?? null,
        policy: model?.policy?.state ?? null,
        contextWindow: limits.max_context_window_tokens ?? null,
        maxPrompt: limits.max_prompt_tokens ?? null,
        maxOutput: limits.max_output_tokens ?? null,
        vision: Boolean(model?.capabilities?.supports?.vision),
        efforts: supportedReasoningEfforts(model),
        notes: (model?.infoMessages ?? []).map((info) => info.message),
      };
    }),
  },
  models,
  cases: results,
  invariants,
  summary,
};
fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
const green = summary.passed === summary.cases && summary.invariantsOk;
console.log(`\n${green ? "ALL PASSED" : "FAILED"}: ${summary.passed}/${summary.cases} cases, ${summary.checksPassed}/${summary.checks} checks  →  ${path.relative(ROOT, outDir)}/results.json`);
if (flag("--publish")) {
  if (!green || scenarios.length !== available.length || models.length !== MODELS.length) {
    console.error("Not publishing: only a complete, passing run of every scenario on every model can be published.");
  } else {
    fs.mkdirSync(path.join(ROOT, "verification"), { recursive: true });
    fs.copyFileSync(path.join(outDir, "results.json"), path.join(ROOT, track.resultsFile));
    console.log(`Published ${track.resultsFile}`);
  }
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(green ? 0 : 1);
