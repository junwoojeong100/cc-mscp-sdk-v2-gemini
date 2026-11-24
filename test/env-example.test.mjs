import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const example = read(".env.example");
// "# NAME=value" lines are the documented variables; prose lines never look like that.
const documented = [...example.matchAll(/^# ([A-Z][A-Z0-9_]+)=(.*)$/gm)].map(([, name, value]) => ({ name, value }));
const sources = [
  ...fs.readdirSync(path.join(ROOT, "src")).map((file) => read("src", file)),
  ...fs.readdirSync(path.join(ROOT, "bin")).map((file) => read("bin", file)),
].join("\n");

test("every variable .env.example documents is read somewhere in src/ or bin/", () => {
  assert.ok(documented.length >= 10);
  for (const { name } of documented) assert.ok(sources.includes(name), `${name} is documented but nothing reads it`);
});

test("no line of .env.example is active, so sourcing it changes nothing", () => {
  const active = example.split("\n").filter((line) => /^[A-Z_]+=/.test(line));
  assert.deepEqual(active, []);
});

test("the documented default model is the one the launcher and the bridge use", () => {
  const model = documented.find((entry) => entry.name === "GHCP_MODEL").value;
  assert.equal(model, "gemini-4-hydrogen");
  assert.match(read("bin/claude-gemini"), /GHCP_MODEL:-gemini-4-hydrogen/);
  assert.match(read("src/server.mjs"), /GHCP_MODEL \|\| "gemini-4-hydrogen"/);
});

test("the documented timeouts and size limits match the bridge's defaults", () => {
  const value = (name) => Number(documented.find((entry) => entry.name === name).value);
  const server = read("src/server.mjs");
  // The code spells numbers like 300_000 or 30 * 60_000.
  const serverDefault = (name) => Function(`return ${server.match(new RegExp(`"${name}",\\s*([^)]+)\\)`))[1]}`)();
  assert.equal(value("TURN_IDLE_TIMEOUT_MS"), serverDefault("TURN_IDLE_TIMEOUT_MS"));
  assert.equal(value("TURN_MAX_DURATION_MS"), serverDefault("TURN_MAX_DURATION_MS"));
  assert.equal(value("MAX_BODY_BYTES"), 256 * 1024 * 1024);
  assert.equal(value("MAX_REPLAY_BYTES"), 256 * 1024 * 1024);
  assert.match(server, /"MAX_BODY_BYTES",\s*256 \* 1024 \* 1024/);
  assert.match(server, /"MAX_REPLAY_BYTES",\s*256 \* 1024 \* 1024/);
});

test("the persistent bridge directory is this lab's own, not the other checkout's", () => {
  assert.notEqual(JSON.parse(read("package.json")).name, "claude-code-ghcp-sdk");
  assert.ok(!/claude-code-ghcp-sdk/.test(read("src/bridge-daemon.mjs")));
});
