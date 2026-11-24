// The live scenarios. Each one drives real Claude Code against the Gemini 4 models
// and returns named checks; nothing here is mocked.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PRIMARY_MODELS } from "../../src/model-map.mjs";
import { runtimePaths } from "../../src/litellm-runtime.mjs";
import {
  MODELS, ROOT, cleanEnv, failuresOf, freePort, makeWorkspace, sleep, turnsOf,
} from "./lib.mjs";
import { renderDigitsPng } from "./png.mjs";
import { TuiSession, chooseModelForSession, parsePicker, reachPrompt } from "./tui.mjs";

const LAB_01 = path.join(ROOT, "labs/01-fix-the-bug");
const NO_TOOLS = ["--restricted", "--permission-mode", "dontAsk", "--tools", ""];
const toolArgs = (tools, allowed = tools) => ["--restricted", "--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", allowed];
const read = (file) => fs.readFileSync(file, "utf8");
const round = (value) => Math.round(value * 10) / 10;

// Models often write `ls -la && node --test` or `cd dir; node --test` instead of the bare
// command. It is a test run when `node --test` is one of the commands in the line; whether
// it really ran is judged from its output, not from its spelling.
export const runsNodeTest = (call) => call.name === "Bash" && /(^|&&|;|\|\|)\s*node --test\b/.test(String(call.input?.command ?? ""));

// What the runtime accepted for each requested effort, as observed on 2026-11-24
// with runtime 1.0.113: it rejects "xhigh" on all four models, so the bridge
// lowers it to "high".
export const EFFORT_EXPECTATION = Object.freeze({
  "gemini-4-argon": { low: "low", high: "high", xhigh: "high" },
  "gemini-4-carbon": { low: "low", high: "high", xhigh: "high" },
  "gemini-4-hydrogen": { low: "low", high: "high", xhigh: "high" },
  "gemini-4-neon": { low: "low", high: "high", xhigh: "high" },
});

class Checks {
  items = [];

  add(name, ok, detail = "") {
    this.items.push({ name, ok: Boolean(ok), detail: ok ? "" : String(detail).slice(0, 3000) });
    return Boolean(ok);
  }

  get ok() {
    return this.items.length > 0 && this.items.every((item) => item.ok);
  }
}

// What the bridge says about the turns in a window: who was asked, who answered, what failed.
// An upstream overload (529) is Claude Code's cue to retry, and the bridge answers an empty
// Gemini response that way; the case still has to end right, so a retried overload is
// recorded as a fact and not counted as a failure. Any other failed request is one.
function bridgeChecks(ctx, checks, window, models) {
  const expected = Array.isArray(models) ? models : [models];
  const turns = turnsOf(window);
  checks.add("the bridge completed at least one turn", turns.length > 0, "no bridge.turn_completed event");
  checks.add("every request named the expected Gemini 4 model", turns.length > 0 &&
    turns.every((turn) => expected.some((id) => turn.requestedModel === ctx.track.requestedModel(id))), turns.map((turn) => turn.requestedModel).join(", "));
  checks.add("the Copilot SDK served every turn with the expected model", turns.length > 0 &&
    turns.every((turn) => expected.includes(turn.model)), turns.map((turn) => turn.model).join(", "));
  const failures = failuresOf(window);
  const retried = failures.filter((failure) => failure.status === 529 && failure.errorType === "overloaded_error");
  const failed = failures.filter((failure) => !retried.includes(failure));
  checks.add("no request failed", failed.length === 0, JSON.stringify(failed));
  return {
    turns: turns.length,
    inputTokens: turns.reduce((sum, turn) => sum + (turn.inputTokens ?? 0), 0),
    outputTokens: turns.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0),
    ...(retried.length ? { upstreamRetries: retried.length } : {}),
  };
}

const exitedNormally = (checks, run) => checks.add("Claude Code exited normally", run.ok,
  `exit=${run.code} timedOut=${run.timedOut} ${run.stderr.split("\n").filter((line) => !line.includes("unrecognized_model")).join(" ").slice(-300)}`);

async function answer(ctx, model) {
  const checks = new Checks();
  const expected = `안녕하세요-${randomBytes(4).toString("hex")}`;
  const mark = ctx.bridge.mark();
  const run = await ctx.claude({ model, cwd: ctx.scratch, prompt: `Reply with exactly this text and nothing else: ${expected}`, args: NO_TOOLS });
  exitedNormally(checks, run);
  checks.add("exact Korean answer", run.text === expected, JSON.stringify(run.text));
  checks.add("Claude Code selected the Gemini model", run.init?.model === ctx.track.clientModel(model), run.init?.model);
  const window = ctx.bridge.since(mark);
  const usage = bridgeChecks(ctx, checks, window, model);
  // The bridge asks the runtime for the long-context tier; the runtime reports the budget it granted.
  const budget = window.find((event) => event.event === "bridge.context_budget");
  const advertised = ctx.catalog?.[model]?.capabilities?.limits?.max_prompt_tokens;
  checks.add("the runtime granted the long-context budget the catalog advertises",
    budget?.contextTier === "long_context" && budget?.tokenLimit === advertised,
    `tier=${budget?.contextTier} limit=${budget?.tokenLimit} catalog=${advertised}`);
  return { checks, facts: { seconds: round(run.durationMs / 1000), ...usage, contextBudget: budget ? { tier: budget.contextTier, tokenLimit: budget.tokenLimit } : null } };
}

async function effort(ctx, model) {
  const checks = new Checks();
  const facts = {};
  for (const requested of ["low", "high", "xhigh"]) {
    const mark = ctx.bridge.mark();
    const run = await ctx.claude({ model, cwd: ctx.scratch, prompt: "Reply with exactly: OK", args: [...NO_TOOLS, "--effort", requested] });
    const window = ctx.bridge.since(mark);
    const state = window.find((event) => event.event === "bridge.verify_model_state");
    const expected = EFFORT_EXPECTATION[model][requested];
    exitedNormally(checks, run);
    checks.add(`--effort ${requested} reached the bridge`, state?.requestedEffort === requested, JSON.stringify(state));
    checks.add(`--effort ${requested} ran as ${expected}`, state?.appliedEffort === expected && state?.current?.reasoningEffort === expected,
      `applied=${state?.appliedEffort} sdk=${state?.current?.reasoningEffort}`);
    checks.add(`--effort ${requested} answered`, run.text === "OK", JSON.stringify(run.text));
    bridgeChecks(ctx, checks, window, model);
    facts[requested] = { applied: state?.appliedEffort ?? null, sdk: state?.current?.reasoningEffort ?? null, contextTier: state?.current?.contextTier ?? null };
  }
  return { checks, facts };
}

async function coding(ctx, model) {
  const checks = new Checks();
  const workspace = makeWorkspace(ctx.root, `coding-${model}`, LAB_01);
  const files = { source: path.join(workspace, "src/stats.mjs"), test: path.join(workspace, "test/stats.test.mjs"), pkg: path.join(workspace, "package.json") };
  const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, read(file)]));
  const mark = ctx.bridge.mark();
  const run = await ctx.claude({
    model,
    cwd: workspace,
    timeoutMs: 300_000,
    args: toolArgs("Read,Edit,Bash", "Read,Edit,Bash(node --test)"),
    prompt: "`node --test`를 실행해서 실패하는 테스트의 원인을 찾고, 테스트 파일은 수정하지 말고 소스 파일만 고쳐서 모든 테스트가 통과하도록 해줘. 마지막에 `node --test`를 다시 실행해서 결과를 확인해줘.",
  });
  const calls = run.toolCalls;
  const firstEdit = calls.findIndex((call) => call.name === "Edit");
  const firstTest = calls.findIndex(runsNodeTest);
  const lastEdit = calls.map((call) => call.name).lastIndexOf("Edit");
  const rerun = lastEdit < 0 ? null : calls.slice(lastEdit + 1).find(runsNodeTest);
  exitedNormally(checks, run);
  checks.add("ran the tests before editing anything", firstTest >= 0 && (firstEdit < 0 || firstTest < firstEdit), `tools=${calls.map((call) => call.name).join(",")} text=${JSON.stringify(run.text).slice(0, 300)} stderr=${run.stderr.slice(-300)}`);
  checks.add("that first run showed the failing test", /not ok|✖|(#|ℹ)\s*fail\s+[1-9]/.test(calls[firstTest]?.output ?? ""), calls[firstTest]?.output);
  const edits = calls.filter((call) => call.name === "Edit");
  checks.add("edited only src/stats.mjs", edits.length > 0 && edits.every((call) => {
    try {
      return fs.realpathSync(call.input.file_path) === fs.realpathSync(files.source);
    } catch {
      return false;
    }
  }), edits.map((call) => call.input?.file_path).join(", "));
  checks.add("re-ran the tests after the last edit and all 4 passed", Boolean(rerun) &&
    /(#|ℹ)\s*pass\s+4\b/.test(rerun.output) && /(#|ℹ)\s*fail\s+0\b/.test(rerun.output), rerun?.output);
  checks.add("test file and package.json are unchanged", read(files.test) === before.test && read(files.pkg) === before.pkg, "a protected file changed");
  checks.add("the source file changed", read(files.source) !== before.source, "src/stats.mjs is unchanged");
  const independent = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", env: cleanEnv() });
  checks.add("independent `node --test` passes 4 of 4", independent.status === 0 && /(#|ℹ)\s*pass\s+4\b/.test(independent.stdout), independent.stdout.slice(-300));
  const usage = bridgeChecks(ctx, checks, ctx.bridge.since(mark), model);
  return { checks, facts: { seconds: round(run.durationMs / 1000), tools: calls.map((call) => call.name), fix: read(files.source).match(/\.sort\([^)]*\)/)?.[0] ?? null, ...usage } };
}

async function vision(ctx, model) {
  const checks = new Checks();
  const workspace = makeWorkspace(ctx.root, `vision-${model}`);
  const code = String(randomInt(10_000, 100_000));
  fs.writeFileSync(path.join(workspace, "code.png"), renderDigitsPng(code));
  const mark = ctx.bridge.mark();
  const run = await ctx.claude({
    model,
    cwd: workspace,
    args: toolArgs("Read"),
    prompt: "Use the Read tool to open the image file code.png in the current directory. Reply with only the digits shown in the image.",
  });
  const digits = run.text.replace(/\D/g, "");
  exitedNormally(checks, run);
  checks.add("opened the image with the Read tool", run.toolCalls.some((call) => call.name === "Read" && /code\.png$/.test(String(call.input?.file_path))), run.toolCalls.map((call) => call.name).join(","));
  checks.add(`read the 5-digit code (${code}) correctly`, digits === code, JSON.stringify(run.text));
  const usage = bridgeChecks(ctx, checks, ctx.bridge.since(mark), model);
  return { checks, facts: { seconds: round(run.durationMs / 1000), ...usage } };
}

async function subagent(ctx, model) {
  const checks = new Checks();
  const workspace = makeWorkspace(ctx.root, `subagent-${model}`, LAB_01);
  const mark = ctx.bridge.mark();
  const run = await ctx.claude({
    model,
    cwd: workspace,
    timeoutMs: 300_000,
    args: toolArgs("Read,Glob,Grep,Agent"),
    prompt: "Use a subagent (the Explore subagent) to find which file defines the function `median` and report only the file path. You must delegate the search to a subagent.",
  });
  const window = ctx.bridge.since(mark);
  exitedNormally(checks, run);
  checks.add("delegated to a subagent", run.toolCalls.some((call) => call.name === "Agent" || call.name === "Task"), run.toolCalls.map((call) => call.name).join(","));
  checks.add("the answer names src/stats.mjs", /src\/stats\.mjs/.test(run.text), JSON.stringify(run.text));
  checks.add("the subagent's own requests reached the bridge", turnsOf(window).some((turn) => turn.claudeAgent === "subagent"), "no subagent turn");
  const usage = bridgeChecks(ctx, checks, window, model);
  return { checks, facts: { seconds: round(run.durationMs / 1000), ...usage } };
}

// A conversation that includes a tool call, continued on the next model of the cycle.
async function switchModel(ctx, model) {
  const checks = new Checks();
  const target = MODELS[(MODELS.indexOf(model) + 1) % MODELS.length];
  const secret = `MARK-${randomBytes(6).toString("hex")}`;
  const sessionId = randomUUID();
  const workspace = makeWorkspace(ctx.root, `switch-${model}`);
  const firstMark = ctx.bridge.mark();
  const first = await ctx.claude({
    model, cwd: workspace,
    args: [...toolArgs("Bash", "Bash(echo *)"), "--session-id", sessionId],
    prompt: `Use the Bash tool to run exactly: echo ${secret}\nThen reply with only the text the command printed.`,
  });
  const firstWindow = ctx.bridge.since(firstMark);
  exitedNormally(checks, first);
  checks.add(`${model} ran the Bash tool and saw the code`, first.toolCalls.some((call) => call.name === "Bash" && call.output.includes(secret)), first.toolCalls.map((call) => call.name).join(","));
  bridgeChecks(ctx, checks, firstWindow, model);
  const secondMark = ctx.bridge.mark();
  const second = await ctx.claude({
    model: target, cwd: workspace,
    args: [...NO_TOOLS, "--resume", sessionId],
    prompt: "What exact text did the Bash command print earlier in this conversation? Reply with only that text. Do not use any tool.",
  });
  exitedNormally(checks, second);
  checks.add(`${target} recalled the tool output from the earlier model's turn`, second.text.includes(secret), JSON.stringify(second.text));
  const usage = bridgeChecks(ctx, checks, ctx.bridge.since(secondMark), target);
  return { checks, facts: { from: model, to: target, seconds: round((first.durationMs + second.durationMs) / 1000), ...usage } };
}

// The shipped launcher, as a user runs it. Direct: it starts a private bridge, so
// nothing observes it. LiteLLM: it talks to the gateway of this run, whose bridge
// is the observed one.
async function launcher(ctx, model) {
  const checks = new Checks();
  const expected = `launcher-${randomBytes(4).toString("hex")}`;
  const configDir = path.join(ctx.root, "launcher-config");
  fs.mkdirSync(configDir, { recursive: true });
  const choice = ctx.litellm ? ["--litellm-model", model, "--litellm-base-url", ctx.litellm.baseUrl] : ["--ghcp-model", model];
  const mark = ctx.bridge.mark();
  const startedAt = Date.now();
  const result = spawnSync(path.join(ROOT, ctx.track.launcher), [
    ...choice, ...NO_TOOLS, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-chrome", "-p", `Reply with exactly this text and nothing else: ${expected}`,
  ], {
    cwd: ctx.scratch, encoding: "utf8", timeout: 300_000 * ctx.timeoutScale,
    env: cleanEnv({
      CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_BIN: ctx.claudeBin, DISABLE_AUTOUPDATER: "1", CI: "1", FORCE_COLOR: "0",
      ...(ctx.litellm ? { LITELLM_API_KEY: ctx.litellm.masterKey } : {}),
    }),
  });
  checks.add("launcher exited 0", result.status === 0, `exit=${result.status} ${result.stderr.slice(-300)}`);
  checks.add("stdout is exactly the answer", result.stdout.trim() === expected, JSON.stringify(result.stdout.trim()));
  // spawnSync blocked this process, so the bridge's log lines are still in the pipe.
  if (ctx.litellm) {
    await sleep(1_500);
    bridgeChecks(ctx, checks, ctx.bridge.since(mark), model);
  }
  return { checks, facts: { seconds: round((Date.now() - startedAt) / 1000), notice: result.stderr.includes("unrecognized_model") } };
}

const bridgeLogEvents = (file) => (fs.existsSync(file) ? read(file).split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
}) : []);

// The interactive TUI through the launcher: the /model picker, switching to every
// Gemini 4 model inside one conversation, and an answer on each.
async function tui(ctx) {
  const checks = new Checks();
  const base = path.join(ctx.root, "tui");
  const configDir = path.join(base, "config");
  const daemonDir = path.join(base, "daemon");
  for (const dir of [configDir, daemonDir]) fs.mkdirSync(dir, { recursive: true });
  const work = makeWorkspace(base, "work");
  const env = cleanEnv({
    CLAUDE_CONFIG_DIR: configDir, GHCP_DAEMON_DIR: daemonDir, CLAUDE_CODE_BIN: ctx.claudeBin, TERM: "xterm-256color", COLORTERM: "truecolor",
    LANG: "en_US.UTF-8", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    // The launcher keeps its settings under the runtime home outside print mode.
    ...(ctx.litellm ? { LITELLM_API_KEY: ctx.litellm.masterKey, GEMINI_LITELLM_HOME: path.join(base, "runtime") } : {}),
  });
  const launch = ctx.litellm
    ? [path.join(ROOT, ctx.track.launcher), "--litellm-model", "gemini-4-hydrogen", "--litellm-base-url", ctx.litellm.baseUrl]
    : [path.join(ROOT, ctx.track.launcher), "--ghcp-model", "gemini-4-hydrogen"];
  const session = new TuiSession({ argv: launch, cwd: work, env, cols: 120, rows: 36 }).start();
  // Direct: the private bridge's own log. LiteLLM: the observed bridge behind the gateway.
  const log = path.join(daemonDir, "bridge.log");
  const began = ctx.bridge.mark();
  const bridgeEvents = () => (ctx.litellm ? ctx.bridge.since(began) : bridgeLogEvents(log));
  const facts = { steps: [] };
  const secret = `CODE-${randomBytes(3).toString("hex")}`;
  const ask = async (prompt, expected, timeoutMs = 120_000) => {
    session.type(prompt);
    await sleep(400);
    session.key("enter");
    const reply = new RegExp(`^⏺\\s+.*${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    await session.waitFor((screen) => reply.test(screen) && !/esc to interrupt/.test(screen), { timeoutMs, label: `the answer ${expected}` });
  };
  try {
    await reachPrompt(session);
    checks.add("the welcome header names Gemini 4 Hydrogen", new RegExp(`${ctx.track.label} · Gemini 4 Hydrogen`).test(session.screen()), session.screen());

    session.type("/model");
    await sleep(600);
    session.key("enter");
    await session.waitFor(/Select model/, { label: "the /model picker", timeoutMs: 30_000 });
    await sleep(400);
    const rows = parsePicker(session.screen());
    checks.add("the /model picker lists all four Gemini 4 models", MODELS.every((id) => rows.some((row) => row.label.includes(`(${id})`))), rows.map((row) => row.label).join(" | "));
    checks.add("the picker marks Hydrogen as current", rows.find((row) => row.checked)?.label.includes("(gemini-4-hydrogen)"), JSON.stringify(rows.find((row) => row.checked)));
    session.key("escape");
    await sleep(800);

    const plan = ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-argon", "gemini-4-carbon"];
    for (const [index, id] of plan.entries()) {
      if (index > 0) await chooseModelForSession(session, id);
      const token = `ACK-${randomBytes(3).toString("hex")}`;
      const from = bridgeEvents().length;
      const prompt = index === 0
        ? `Remember this code: ${secret}. Then reply with exactly: ${token}`
        : `Reply with exactly: ${token}`;
      await ask(prompt, token);
      await sleep(1_000);
      const turns = turnsOf(bridgeEvents().slice(from));
      checks.add(`${id}: answered in the TUI and the SDK served it`, turns.some((turn) => turn.model === id && turn.requestedModel === ctx.track.requestedModel(id)), turns.map((turn) => `${turn.requestedModel}->${turn.model}`).join(", "));
      checks.add(`${id}: every turn in this step stayed on Gemini 4`, turns.length > 0 && turns.every((turn) => PRIMARY_MODELS.includes(turn.model)), turns.map((turn) => turn.model).join(", "));
      facts.steps.push({ model: id, turns: turns.map((turn) => ({ requested: turn.requestedModel, served: turn.model, in: turn.inputTokens, out: turn.outputTokens })) });
    }
    const recallFrom = bridgeEvents().length;
    let recalled = false;
    let recallError = "";
    try {
      await ask("What code did I ask you to remember at the start? Reply with only the code.", secret);
      recalled = true;
    } catch (error) {
      recallError = error.message;
    }
    await sleep(1_000);
    const recall = turnsOf(bridgeEvents().slice(recallFrom));
    checks.add("the last model answered with the code given to the first model", recalled, recallError);
    checks.add("the recall was served by Carbon", recall.some((turn) => turn.model === "gemini-4-carbon"), recall.map((turn) => turn.model).join(", "));

    const allTurns = turnsOf(bridgeEvents());
    checks.add("every request in the session stayed on Gemini 4", allTurns.length > 0 && allTurns.every((turn) => PRIMARY_MODELS.some((id) => turn.model === id && turn.requestedModel === ctx.track.requestedModel(id))),
      allTurns.map((turn) => `${turn.requestedModel}->${turn.model}`).join(", "));
    const settingsFile = path.join(configDir, "settings.json");
    const saved = fs.existsSync(settingsFile) ? JSON.parse(read(settingsFile)) : {};
    checks.add('choosing with "s" saved no model in settings.json', !("model" in saved), JSON.stringify(saved));
    facts.turns = allTurns.length;
    session.type("/exit");
    await sleep(500);
    session.key("enter");
    const deadline = Date.now() + 30_000;
    while (session.exit === null && Date.now() < deadline) await sleep(200);
    checks.add("Claude Code exited with /exit", session.exit === 0, `exit=${session.exit}`);
  } catch (error) {
    checks.add("the TUI scenario completed", false, error.message);
  } finally {
    await session.stop();
    if (!ctx.litellm) {
      try {
        execFileSync(path.join(ROOT, "bin/claude-gemini-stop"), { env, encoding: "utf8", timeout: 60_000 });
      } catch (error) {
        checks.add("the persistent bridge stopped", false, error.message);
      }
    }
  }
  if (!ctx.litellm) {
    const status = spawnSync(path.join(ROOT, "bin/claude-gemini-status"), { env, encoding: "utf8" });
    checks.add("no bridge is left running", /"running":false/.test(status.stdout), status.stdout);
  }
  return { checks, facts };
}

// The shipped gateway commands end to end, in a home of their own: up, Claude Code
// through the gateway, status, turns, logs and down. It runs the LiteLLM that
// `gemini-litellm setup` installed with a key of its own, so it neither reads nor
// disturbs a gateway the user has running.
async function gateway(ctx) {
  const checks = new Checks();
  const base = path.join(ctx.root, "gateway");
  const home = path.join(base, "runtime");
  const configDir = path.join(base, "config");
  for (const dir of [home, configDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.dirname(path.dirname(runtimePaths(cleanEnv()).python)), path.join(home, "litellm-venv"));
  const masterKey = `sk-${randomBytes(32).toString("hex")}`;
  fs.writeFileSync(path.join(home, "litellm-master-key"), `${masterKey}\n`, { mode: 0o600 });
  const port = await freePort();
  const env = cleanEnv({ GEMINI_LITELLM_HOME: home, CLAUDE_CODE_BIN: ctx.claudeBin, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1", CI: "1", FORCE_COLOR: "0" });
  const run = (bin, args, timeoutMs = 180_000) => spawnSync(path.join(ROOT, bin), args, { cwd: ctx.scratch, encoding: "utf8", env, timeout: timeoutMs * ctx.timeoutScale });
  const json = (result) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  };
  const output = (result) => `exit=${result.status} ${result.stdout.slice(-400)} ${result.stderr.slice(-400)}`;
  const expected = `gateway-${randomBytes(4).toString("hex")}`;
  const startedAt = Date.now();
  try {
    const up = run("bin/gemini-litellm", ["up", "--port", String(port), "--model", "gemini-4-hydrogen"]);
    checks.add("up started the bridge and LiteLLM", up.status === 0 && /Bridge\s+http/.test(up.stdout) && /LiteLLM\s+http/.test(up.stdout), output(up));
    checks.add("up reports all four Gemini 4 aliases", MODELS.every((id) => up.stdout.includes(id)), up.stdout);
    const again = run("bin/gemini-litellm", ["up", "--port", String(port)]);
    checks.add("a second up reuses the running gateway", again.status === 0 && /already running/.test(again.stdout), output(again));
    const status = json(run("bin/gemini-litellm", ["status", "--json"]));
    checks.add("status: LiteLLM and the bridge run, and LiteLLM holds the bridge's token", Boolean(status?.litellm.running && status.bridge.running && status.inSync), JSON.stringify(status));
    checks.add("status lists the four aliases", MODELS.every((id) => status?.litellm.models.includes(id)), JSON.stringify(status?.litellm.models));
    const answer = run("bin/claude-gemini-litellm", [
      "--litellm-model", "gemini-4-neon", "--litellm-base-url", `http://127.0.0.1:${port}`, ...NO_TOOLS, "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome",
      "-p", `Reply with exactly this text and nothing else: ${expected}`,
    ], 300_000);
    checks.add("Claude Code answered through the gateway", answer.status === 0 && answer.stdout.trim() === expected, output(answer));
    const turns = run("bin/gemini-litellm", ["turns"]);
    checks.add("turns shows Neon asked for and Neon serving", /gemini-4-neon\s+gemini-4-neon/.test(turns.stdout), output(turns));
    const logs = run("bin/gemini-litellm", ["logs"]);
    checks.add("the LiteLLM log records the request", /POST \/v1\/messages\S*.* 200/.test(logs.stdout), output(logs));
    // With an api_key in its config, LiteLLM answers a token-count request by posting the whole
    // conversation to api.anthropic.com. This config has none, so it must count on its own.
    const count = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": masterKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-4-neon", messages: [{ role: "user", content: `Count the tokens of ${expected}` }] }),
      signal: AbortSignal.timeout(30_000),
    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }), (error) => ({ status: 0, body: error.message }));
    const litellmLog = fs.readFileSync(path.join(home, "litellm.log"), "utf8");
    checks.add(
      "token counting stays inside LiteLLM: a count answers 200 and nothing in its log mentions Anthropic",
      count.status === 200 && Number.isInteger(count.body?.input_tokens) && count.body.input_tokens > 0 && !/anthropic\.com/i.test(litellmLog),
      `status=${count.status} ${JSON.stringify(count.body)} log mentions anthropic.com: ${/anthropic\.com/i.test(litellmLog)}`,
    );
  } finally {
    const down = run("bin/gemini-litellm", ["down"]);
    checks.add("down stopped LiteLLM and the bridge", down.status === 0 && /LiteLLM stopped/.test(down.stdout) && /Bridge stopped/.test(down.stdout), output(down));
  }
  const after = json(run("bin/gemini-litellm", ["status", "--json"]));
  checks.add("status reports both stopped", Boolean(after && !after.litellm.running && !after.bridge.running), JSON.stringify(after));
  const leftovers = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(home));
  checks.add("no process of this gateway is left running", leftovers.length === 0, leftovers.join(" | "));
  return { checks, facts: { seconds: round((Date.now() - startedAt) / 1000) } };
}

export const SCENARIOS = [
  { id: "answer", title: "Korean answer", perModel: true, run: answer },
  { id: "effort", title: "Reasoning effort", perModel: true, run: effort },
  { id: "coding", title: "Fix a failing test with tools", perModel: true, run: coding },
  { id: "vision", title: "Read an image", perModel: true, run: vision },
  { id: "subagent", title: "Subagent", perModel: true, run: subagent },
  { id: "switch", title: "Switch model mid-conversation", perModel: true, run: switchModel },
  { id: "launcher", title: "Launcher", perModel: true, run: launcher },
  { id: "tui", title: "Interactive /model picker", perModel: false, run: tui },
  { id: "gateway", title: "gemini-litellm gateway commands", perModel: false, tracks: ["litellm"], run: gateway },
];

// The scenarios that apply to a track: all of them unless a scenario names its tracks.
export const scenariosFor = (track) => SCENARIOS.filter((scenario) => !scenario.tracks || scenario.tracks.includes(track.id));
