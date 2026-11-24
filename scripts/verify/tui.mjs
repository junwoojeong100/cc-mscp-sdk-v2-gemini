import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const { Terminal } = xterm;
const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-relay.py");

export const KEYS = Object.freeze({
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
});

// One interactive program in a PTY, rendered into a virtual terminal so a test
// can read what is on the screen instead of the raw escape sequences.
export class TuiSession {
  constructor({ argv, cwd, env, cols = 150, rows = 46 }) {
    this.spec = { argv, cwd, env, cols, rows };
    this.terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.exit = null;
    this.rawBytes = 0;
    this.writeQueue = Promise.resolve();
    // Output chunks and capture marks, each with its time in ms since start.
    this.frames = [];
    this.startedAt = Date.now();
    // The program may ask the terminal questions (cursor position, colors);
    // the virtual terminal's answers go back as typed input.
    this.terminal.onData((data) => this.#send({ input: Buffer.from(data).toString("base64") }));
  }

  start() {
    this.startedAt = Date.now();
    this.child = spawn("python3", [RELAY, JSON.stringify(this.spec)], { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.output) {
          const bytes = Buffer.from(message.output, "base64");
          this.rawBytes += bytes.length;
          this.frames.push({ t: Date.now() - this.startedAt, data: message.output });
          this.writeQueue = this.writeQueue.then(() => new Promise((resolve) => this.terminal.write(bytes, resolve)));
        } else if ("exit" in message) {
          this.exit = message.exit;
        }
      }
    });
    this.child.stdin.on("error", () => {});
    return this;
  }

  #send(message) {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  type(text) {
    this.#send({ input: Buffer.from(text, "utf8").toString("base64") });
  }

  // Types one character at a time, so a recording shows the command being typed.
  async typeSlowly(text, { delayMs = 35 } = {}) {
    for (const character of text) {
      this.type(character);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  key(name) {
    this.type(KEYS[name]);
  }

  // Marks the moment a still image should be taken, after output so far has drawn.
  async mark(label) {
    await this.writeQueue;
    this.frames.push({ t: Date.now() - this.startedAt, mark: label });
  }

  recording() {
    return { header: { cols: this.spec.cols, rows: this.spec.rows }, frames: this.frames };
  }

  // The visible screen, one string per row with trailing blanks removed.
  screen({ scrollback = false } = {}) {
    const buffer = this.terminal.buffer.active;
    const first = scrollback ? 0 : buffer.baseY;
    const rows = [];
    for (let y = first; y < buffer.length; y += 1) {
      rows.push((buffer.getLine(y)?.translateToString(true) ?? "").trimEnd());
    }
    return rows.join("\n");
  }

  async waitFor(test, { timeoutMs = 60_000, label = "screen condition", scrollback = false } = {}) {
    const matches = typeof test === "function" ? test : (screen) => test.test(screen);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.writeQueue;
      const screen = this.screen({ scrollback });
      if (matches(screen)) return screen;
      if (this.exit !== null) throw new Error(`The program exited (${this.exit}) while waiting for ${label}.\n${screen}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.\n${this.screen()}`);
  }

  async stop() {
    this.#send({ signal: "SIGTERM" });
    const timer = setTimeout(() => this.#send({ signal: "SIGKILL" }), 5_000);
    this.child?.stdin.end();
    await this.closed;
    clearTimeout(timer);
    await this.writeQueue;
    this.terminal.dispose();
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Claude Code's input line: an empty "❯" at the start of a row, under the welcome header.
export const atPrompt = (screen) => /^❯\s*$/m.test(screen) && /Claude Code v\d/.test(screen);

// First-run screens in a fresh Claude Code config directory. Each one is answered
// the safe way: Enter for theme and security notes, Esc to skip the terminal-setup
// offer (accepting it would change the real terminal's settings), and the folder
// trust prompt only once "Yes, I trust this folder" is the highlighted choice.
export async function reachPrompt(session, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await session.writeQueue;
    const screen = session.screen();
    if (atPrompt(screen)) return screen;
    if (/Do you want to use this API key\?/.test(screen)) {
      throw new Error("Claude Code found an API key this lab did not set; refusing to confirm it.");
    }
    if (/Choose the text style|Press Enter to continue/.test(screen)) session.key("enter");
    else if (/Use Claude Code's terminal setup\?/.test(screen)) session.key("escape");
    else if (/trust this folder|Accessing workspace/i.test(screen)) {
      if (/^\s*❯\s+Yes, I trust this folder/m.test(screen)) session.key("enter");
      else if (/^\s*❯\s+No, exit/m.test(screen)) session.key("down");
    }
    if (session.exit !== null) throw new Error(`The program exited (${session.exit}) before the prompt.\n${screen}`);
    await pause(1_500);
  }
  throw new Error(`No prompt after ${timeoutMs} ms.\n${session.screen()}`);
}

// The numbered rows of the /model picker, and which one is highlighted or checked.
export function parsePicker(screen) {
  const section = screen.slice(screen.lastIndexOf("Select model"));
  const rows = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^\s*(❯\s+)?(\d+)\.\s+(.*?)(\s+✔)?(\s{2,}.*)?$/u);
    if (match) rows.push({ index: Number(match[2]), label: match[3].trim(), highlighted: Boolean(match[1]), checked: Boolean(match[4]) });
  }
  return rows;
}

// Opens /model, moves to the row for `modelId`, and presses "s" (this session only).
// Enter would save the model as the user-wide default, which a plain `claude` cannot serve.
// `onStage` lets a recording take a still at "picker", "highlighted", "confirm" and "done".
export async function chooseModelForSession(session, modelId, { onStage } = {}) {
  session.type("/model");
  await pause(600);
  session.key("enter");
  await session.waitFor(/Select model/, { label: "the /model picker", timeoutMs: 30_000 });
  await pause(400);
  await onStage?.("picker");
  const rows = parsePicker(session.screen());
  const target = rows.find((row) => row.label.includes(`(${modelId})`));
  const current = rows.find((row) => row.highlighted);
  if (!target || !current) throw new Error(`The /model picker has no row for ${modelId}.\n${session.screen()}`);
  for (let step = 0; step < Math.abs(target.index - current.index); step += 1) {
    session.key(target.index > current.index ? "down" : "up");
    await pause(250);
  }
  await pause(400);
  const highlighted = parsePicker(session.screen()).find((row) => row.highlighted);
  if (!highlighted?.label.includes(`(${modelId})`)) throw new Error(`The picker highlights ${highlighted?.label}, not ${modelId}.`);
  await onStage?.("highlighted");
  session.type("s");
  // With a conversation under way Claude Code asks once more, because the new model
  // has to re-read the whole history. "Yes, switch" is the highlighted answer.
  const screen = await session.waitFor(
    (current) => /Switch model\?/.test(current) || new RegExp(`Set model to .*\\(${modelId}\\)`).test(current),
    { label: "the model switch to be accepted", timeoutMs: 30_000 },
  );
  if (/Switch model\?/.test(screen)) {
    if (!new RegExp(`^\\s*❯\\s+1\\.\\s+Yes, switch to .*\\(${modelId}\\)`, "m").test(screen)) {
      throw new Error(`The switch confirmation does not offer ${modelId}.\n${screen}`);
    }
    await pause(600);
    await onStage?.("confirm");
    session.key("enter");
  }
  await session.waitFor(new RegExp(`Set model to .*\\(${modelId}\\).* for this session only`), { label: `the switch to ${modelId}`, timeoutMs: 30_000 });
  await pause(400);
  await onStage?.("done");
}
