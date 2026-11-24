import fs from "node:fs";

import { daemonPaths } from "./bridge-daemon.mjs";

const all = process.argv.includes("--all");
const limitArg = process.argv.find((argument) => /^--last=\d+$/.test(argument));
const limit = all ? Infinity : Number(limitArg?.slice(7) ?? 20);

const { log } = daemonPaths();
if (!fs.existsSync(log)) {
  console.error(`No bridge log yet (${log}). Start a session first: claude-gemini`);
  process.exit(1);
}

const short = (model) => String(model ?? "-").replace(/^github-copilot\/claude-/, "");
const turns = fs.readFileSync(log, "utf8").split("\n").flatMap((line) => {
  try {
    const event = JSON.parse(line);
    return event.event === "bridge.turn_completed" ? [event] : [];
  } catch {
    return [];
  }
});

if (!turns.length) {
  console.log("The bridge has not completed a turn yet.");
  process.exit(0);
}

const shown = turns.slice(-limit);
const offset = turns.length - shown.length;
const rows = shown.map((turn, index) => ({
  n: String(offset + index + 1),
  agent: turn.claudeAgent,
  asked: short(turn.requestedModel),
  served: turn.model,
  tokens: `${(turn.inputTokens ?? 0).toLocaleString("en-US")} / ${(turn.outputTokens ?? 0).toLocaleString("en-US")}`,
  stop: turn.stopReason,
}));
const columns = [["#", "n"], ["AGENT", "agent"], ["ASKED FOR", "asked"], ["SERVED BY", "served"], ["TOKENS IN/OUT", "tokens"], ["STOP", "stop"]];
const widths = columns.map(([title, key]) => Math.max(title.length, ...rows.map((row) => row[key].length)));
const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
console.log(line(columns.map(([title]) => title)));
for (const row of rows) console.log(line(columns.map(([, key]) => row[key])));
