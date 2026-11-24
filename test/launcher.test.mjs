import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin/claude-gemini");

const run = (args, options = {}) => spawnSync(LAUNCHER, args, { encoding: "utf8", timeout: 30_000, ...options });

test("--help lists the four Gemini 4 models and the default", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  for (const id of ["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"]) assert.match(result.stdout, new RegExp(id));
  assert.match(result.stdout, /default: gemini-4-hydrogen/);
  assert.match(result.stdout, /claude-gemini-status\/claude-gemini-stop/);
});

test("--model and --settings are refused, because they would make the backend ambiguous", () => {
  for (const argument of [["--model", "x"], ["--model=x"], ["--settings", "x"], ["--settings=x"], ["--", "--model", "x"]]) {
    const result = run(argument);
    assert.equal(result.status, 2, argument.join(" "));
    assert.match(result.stderr, /--ghcp-model|--settings|GHCP launcher options/);
  }
});

test("--ghcp-model needs a value", () => {
  const result = run(["--ghcp-model"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--ghcp-model requires a value/);
});

// The real Claude Code is found by skipping this repository's launchers on PATH.
// The resolver canonicalises each candidate with node, so node must be on PATH.
function resolveWith(pathDirs, extraEnv = {}) {
  const nodeDir = path.dirname(process.execPath);
  return spawnSync("bash", ["-c", `source "${ROOT}/bin/resolve-claude.sh" && resolve_claude_code_bin "${ROOT}"`], {
    encoding: "utf8",
    env: { PATH: [...pathDirs, nodeDir, "/usr/bin", "/bin"].join(":"), ...extraEnv },
  });
}

test("a claude on PATH that is this repository's launcher is skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-claude-"));
  const wrapperDir = path.join(dir, "wrapper");
  const realDir = path.join(dir, "real");
  fs.mkdirSync(wrapperDir);
  fs.mkdirSync(realDir);
  fs.symlinkSync(LAUNCHER, path.join(wrapperDir, "claude"));
  fs.writeFileSync(path.join(realDir, "claude"), "#!/bin/sh\necho real\n", { mode: 0o755 });
  const result = resolveWith([wrapperDir, realDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(path.join(realDir, "claude")));
});

test("with only a launcher on PATH there is no Claude Code, and the message says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-claude-"));
  fs.symlinkSync(LAUNCHER, path.join(dir, "claude"));
  const result = resolveWith([dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Claude Code executable not found/);
});

test("CLAUDE_CODE_BIN may not name a launcher", () => {
  const result = resolveWith([], { CLAUDE_CODE_BIN: LAUNCHER });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must point to the real Claude Code executable/);
});

test("lab start copies a lab, starts a git history and can be run again", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lab-start-"));
  const env = { ...process.env, LAB_PARENT: parent };
  const first = spawnSync(path.join(ROOT, "labs/start"), ["01"], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  const lab = path.join(parent, "lab-01");
  assert.ok(fs.existsSync(path.join(lab, "src/stats.mjs")));
  const log = spawnSync("git", ["-C", lab, "log", "--oneline"], { encoding: "utf8" });
  assert.match(log.stdout, /start of lab 01/);
  fs.writeFileSync(path.join(lab, "src/stats.mjs"), "// changed\n");
  const again = spawnSync(path.join(ROOT, "labs/start"), ["01"], { encoding: "utf8", env });
  assert.equal(again.status, 0, again.stderr);
  assert.match(fs.readFileSync(path.join(lab, "src/stats.mjs"), "utf8"), /export function median/);
  const unknown = spawnSync(path.join(ROOT, "labs/start"), ["99"], { encoding: "utf8", env });
  assert.equal(unknown.status, 2);
});

test("the first lab fails exactly one test, so there is something for the model to fix", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lab-start-"));
  spawnSync(path.join(ROOT, "labs/start"), ["01"], { env: { ...process.env, LAB_PARENT: parent } });
  const result = spawnSync(process.execPath, ["--test"], { cwd: path.join(parent, "lab-01"), encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /# pass 3/);
  assert.match(result.stdout, /# fail 1/);
  assert.match(result.stdout, /not ok \d+ - median sorts numbers by value, not as text/);
});
