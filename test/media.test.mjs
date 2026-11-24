import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import {
  cellWidth, maskRulesFor, maskSnapshot, rowText, screenHtml, trimSnapshot,
} from "../scripts/media/render.mjs";
import { atPrompt, parsePicker } from "../scripts/verify/tui.mjs";

// One screen row as terminal cells, the way the virtual terminal reports them.
function cellsOf(text, cols, style = {}) {
  const cells = [];
  for (const char of text) {
    const width = cellWidth(char.codePointAt(0));
    cells.push({ ch: char, w: width, fg: -1, bg: -1, ...style });
    if (width === 2) cells.push({ ch: "", w: 0, fg: -1, bg: -1, ...style });
  }
  while (cells.length < cols) cells.push({ ch: "", w: 1, fg: -1, bg: -1 });
  return cells;
}
const snapshotOf = (...rows) => ({ cols: 60, rows: rows.map((row) => cellsOf(row.text ?? row, 60, row.style)), cursor: { x: 0, y: 0, hidden: true } });

test("Hangul takes two columns and ordinary text one", () => {
  assert.equal(cellWidth("a".codePointAt(0)), 1);
  assert.equal(cellWidth("한".codePointAt(0)), 2);
  assert.equal(cellWidth("─".codePointAt(0)), 1);
  assert.equal(cellWidth("⏺".codePointAt(0)), 1);
});

test("the home directory, the account name and the signed-in login are masked", () => {
  const home = os.homedir();
  const user = os.userInfo().username;
  const rules = maskRulesFor({ mask: [{ literal: "octocat_corp", text: "your-login" }] });
  const masked = maskSnapshot(snapshotOf(`${home}/.local/bin/claude`, "Signed in as octocat_corp (https://github.com)", `owner ${user} here`), rules);
  assert.equal(rowText(masked.rows[0]).trimEnd(), "~/.local/bin/claude");
  assert.equal(rowText(masked.rows[1]).trimEnd(), "Signed in as your-login (https://github.com)");
  assert.equal(rowText(masked.rows[2]).trimEnd(), "owner user here");
});

test("masking keeps the row as wide as it was and keeps the style of what it replaces", () => {
  const home = os.homedir();
  const styled = { text: `${home}/x`, style: { fg: 3, bold: true } };
  const masked = maskSnapshot(snapshotOf(styled), maskRulesFor({}));
  assert.equal(masked.rows[0].length, 60);
  assert.equal(masked.rows[0][0].ch, "~");
  assert.equal(masked.rows[0][0].fg, 3);
  assert.equal(masked.rows[0][0].bold, true);
});

test("a long hex token is hidden, a short one is left alone", () => {
  const masked = maskSnapshot(snapshotOf("token 0123456789abcdef0123456789abcdef!", "id 0123abcd"), maskRulesFor({}));
  assert.match(rowText(masked.rows[0]), /token <token>!/);
  assert.match(rowText(masked.rows[1]), /id 0123abcd/);
});

test("a screen is drawn on a fixed grid, with wide glyphs in their own two columns", () => {
  const html = screenHtml(snapshotOf("ab 한글", { text: "red", style: { fg: 1 } }));
  assert.match(html, /<div class="grid" style="width:60ch;height:44px">/);
  assert.match(html, /left:0ch;[^"]*">ab 한글|left:3ch;[^"]*width:2ch;text-align:center">한/);
  assert.match(html, /color:#cc0000/);
});

test("markup in a screen cannot break out of the page", () => {
  const html = screenHtml(snapshotOf("<script>alert(1)</script>"));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("a still drops the empty rows under the last content but keeps a minimum, painted rows and the cursor row", () => {
  const blank = Array(12).fill("");
  const short = snapshotOf("$ ls", "a.txt", "$", ...blank);
  assert.equal(trimSnapshot(short, { minRows: 2 }).rows.length, 3);
  assert.equal(trimSnapshot(short).rows.length, 8);
  const painted = snapshotOf("x", "", { text: " ", style: { bg: 4 } }, ...blank);
  assert.equal(trimSnapshot(painted, { minRows: 1 }).rows.length, 3);
  const cursorLow = { ...short, cursor: { x: 0, y: 6, hidden: false } };
  assert.equal(trimSnapshot(cursorLow, { minRows: 1 }).rows.length, 7);
  assert.equal(trimSnapshot(snapshotOf("only"), { minRows: 8 }).rows.length, 1);
});

const PICKER = `
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions.
     1. Default (recommended)                                     Use the default model (currently GitHub Copilot ·
                                                                  Gemini 4 Neon (gemini-4-neon))
     2. GitHub Copilot · Gemini 4 Argon (gemini-4-argon)          Routed through Microsoft Copilot SDK
     3. GitHub Copilot · Gemini 4 Carbon (gemini-4-carbon)        Routed through Microsoft Copilot SDK
   ❯ 4. GitHub Copilot · Gemini 4 Hydrogen (gemini-4-hydrogen) ✔  Routed through Microsoft Copilot SDK
     5. GitHub Copilot · Gemini 4 Neon (gemini-4-neon)            Routed through Microsoft Copilot SDK
   ● High effort (default) ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel`;

test("the /model picker rows are read with the highlighted and the checked row", () => {
  const rows = parsePicker(PICKER);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3, 4, 5]);
  assert.equal(rows.find((row) => row.highlighted).index, 4);
  assert.equal(rows.find((row) => row.checked).index, 4);
  assert.match(rows[1].label, /\(gemini-4-argon\)$/);
  assert.match(rows[3].label, /\(gemini-4-hydrogen\)/);
});

test("the input prompt is told apart from a dialog's selection marker", () => {
  const welcome = "▗ ▗   ▖ ▖  Claude Code v2.1.283\n\n❯\n\n  ⏵⏵ auto mode on";
  assert.equal(atPrompt(welcome), true);
  assert.equal(atPrompt(" ❯ 1. Yes, I trust this folder\n   2. No, exit\nClaude Code v2.1.283"), false);
  assert.equal(atPrompt("❯ Reply with exactly: OK\nClaude Code v2.1.283"), false);
});
