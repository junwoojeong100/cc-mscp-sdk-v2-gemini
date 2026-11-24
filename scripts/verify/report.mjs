#!/usr/bin/env node
// Prints a recorded verification result as a table: verification/results.json, or
// with --via litellm verification/results-litellm.json, or the file named.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trackNamed } from "./tracks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const via = args.includes("--via") ? args[args.indexOf("--via") + 1] : "direct";
const named = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--via");
const file = named ?? path.join(root, trackNamed(via).resultsFile);
if (!fs.existsSync(file)) {
  console.error(`No result file at ${file}. Run: npm run verify${via === "direct" ? "" : ` -- --via ${via}`} -- --publish`);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const models = report.models;
const shortName = (id) => id.replace("gemini-4-", "");
const scenarios = [...new Set(report.cases.map((entry) => entry.scenario))];

const SINGLE_CASE = { tui: "all four in one session", gateway: "the gemini-litellm commands" };
const cell = (entry) => (entry ? `${entry.ok ? "✓" : "✗"} ${entry.seconds.toFixed(1)}s` : "-");
const rows = scenarios.map((scenario) => {
  const entries = report.cases.filter((entry) => entry.scenario === scenario);
  if (entries.length === 1 && entries[0].model === null) {
    return [scenario, ...models.map(() => ""), `${cell(entries[0])}  (${SINGLE_CASE[scenario] ?? "one session"})`];
  }
  return [scenario, ...models.map((model) => cell(entries.find((entry) => entry.model === model)))];
});
const header = ["scenario", ...models.map(shortName)];
const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => String(row[index] ?? "").length)));
const line = (cells) => cells.map((value, index) => String(value ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();

const env = report.environment;
console.log(`Claude Code ${env.claudeCode}${env.litellm ? ` · LiteLLM ${env.litellm}` : ""} · Copilot SDK ${env.copilotSdk} (runtime ${env.copilotRuntime}) · Node ${env.node} · ${report.startedAt.slice(0, 10)}\n`);
console.log(line(header));
for (const row of rows) console.log(line(row));
const { summary } = report;
console.log(`\n${summary.passed}/${summary.cases} cases passed · ${summary.checksPassed}/${summary.checks} checks passed`);
for (const invariant of report.invariants) console.log(`${invariant.ok ? "✓" : "✗"} ${invariant.name}`);
if (summary.passed !== summary.cases || !summary.invariantsOk) process.exitCode = 1;
