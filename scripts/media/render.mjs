// Turns a recorded terminal session into screen images and video frames.
//
// A recording is the raw output of a real PTY session, with the time of each chunk
// and the capture marks a scene set. It is replayed into a virtual terminal, the
// resulting grid of cells is masked (home directory, account name), and each grid
// is drawn as HTML and photographed by headless Chromium.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import xterm from "@xterm/headless";

const { Terminal } = xterm;

// Hangul, CJK and emoji take two columns, as a real terminal shows them.
const WIDE = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6]];
const widthCache = new Map();
export function cellWidth(codePoint) {
  if (codePoint < 0x300) return codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0) ? 0 : 1;
  let width = widthCache.get(codePoint);
  if (width === undefined) {
    const char = String.fromCodePoint(codePoint);
    width = /[\p{Mn}\p{Me}\p{Cf}]/u.test(char) ? 0
      : /\p{Emoji_Presentation}/u.test(char) || WIDE.some(([from, to]) => codePoint >= from && codePoint <= to) ? 2 : 1;
    widthCache.set(codePoint, width);
  }
  return width;
}
const UNICODE = {
  version: "lab-widths",
  wcwidth: cellWidth,
  charProperties(codePoint, preceding) {
    let width = cellWidth(codePoint);
    let join = width === 0 && preceding !== 0;
    if (join) {
      const previous = (preceding >> 1) & 3;
      if (!previous) join = false;
      else if (previous > width) width = previous;
    }
    return ((width & 3) << 1) | (join ? 1 : 0);
  },
};

// ---------------------------------------------------------------- replay

export function createReplay({ header, frames }) {
  const terminal = new Terminal({ cols: header.cols, rows: header.rows, scrollback: 0, allowProposedApi: true });
  terminal.unicode.register(UNICODE);
  terminal.unicode.activeVersion = UNICODE.version;
  const decoder = new StringDecoder("utf8");
  let next = 0;
  return {
    async advance(toMs) {
      let text = "";
      for (; next < frames.length && frames[next].t <= toMs; next += 1) {
        if (frames[next].data) text += decoder.write(Buffer.from(frames[next].data, "base64"));
      }
      if (text) await new Promise((resolve) => terminal.write(text, resolve));
    },
    snapshot: () => snapshotTerminal(terminal),
    dispose: () => terminal.dispose(),
  };
}

const colorOf = (isDefault, isRGB, value) => (isDefault ? -1 : isRGB ? `#${value.toString(16).padStart(6, "0")}` : value);

export function snapshotTerminal(terminal) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const rows = [];
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.baseY + y);
    const cells = [];
    for (let x = 0; x < terminal.cols; x += 1) {
      if (!line?.getCell(x, cell)) {
        cells.push({ ch: "", w: 1, fg: -1, bg: -1 });
        continue;
      }
      const entry = {
        ch: cell.getChars(),
        w: cell.getWidth(),
        fg: colorOf(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()),
        bg: colorOf(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()),
      };
      if (cell.isBold()) entry.bold = true;
      if (cell.isItalic()) entry.italic = true;
      if (cell.isDim()) entry.dim = true;
      if (cell.isUnderline()) entry.underline = true;
      if (cell.isInverse()) entry.inverse = true;
      if (cell.isStrikethrough()) entry.strike = true;
      if (cell.isInvisible()) entry.invisible = true;
      cells.push(entry);
    }
    rows.push(cells);
  }
  const cursor = { x: buffer.cursorX, y: buffer.cursorY, hidden: Boolean(terminal._core?.coreService?.isCursorHidden) };
  return { cols: terminal.cols, rows, cursor };
}

export const rowText = (cells) => cells.map((cell) => (cell.w === 0 ? "" : cell.ch || " ")).join("");

// A still needs no empty rows under the last thing on screen: a nearly empty terminal
// would otherwise be a mostly empty picture. The cursor's row and `minRows` are kept.
export function trimSnapshot(snapshot, { minRows = 8 } = {}) {
  const used = (cells) => cells.some((cell) => (cell.ch && cell.ch !== " ") || (cell.bg !== -1 && cell.bg !== undefined));
  let last = snapshot.rows.length - 1;
  while (last > 0 && !used(snapshot.rows[last])) last -= 1;
  const keep = Math.min(snapshot.rows.length, Math.max(minRows, last + 1, snapshot.cursor.y + 1));
  return { ...snapshot, rows: snapshot.rows.slice(0, keep) };
}

// ---------------------------------------------------------------- masking

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What must not appear in a published capture, and what stands in for it.
export function maskRules({ extra = [] } = {}) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const realHome = (() => {
    try {
      return fs.realpathSync(home);
    } catch {
      return home;
    }
  })();
  return [
    ...extra,
    ...[...new Set([home, realHome])].map((value) => ({ pattern: new RegExp(literal(value), "g"), text: "~" })),
    { pattern: /(?:\/private)?\/var\/folders\/[^\s"'`<>|│]+/g, text: "/tmp/work" },
    { pattern: new RegExp(`(?<![A-Za-z])${literal(user)}(?![A-Za-z])`, "gi"), text: "user" },
    { pattern: /(?<![A-Za-z0-9_-])[A-Fa-f0-9]{32,}(?![A-Za-z0-9_-])/g, text: "<token>" },
  ];
}

// Replaces each match in one row by splicing cells, so the replacement keeps the
// style of the cell it starts on. The row stays as wide as it was.
function maskRow(cells, { pattern, text: replacement }) {
  let text = "";
  const owner = [];
  cells.forEach((cell, index) => {
    const piece = cell.w === 0 ? "" : cell.ch || " ";
    text += piece;
    for (let i = 0; i < piece.length; i += 1) owner.push(index);
  });
  const matches = [...text.matchAll(pattern)].filter((match) => match[0].length > 0);
  if (!matches.length) return cells;
  const out = [];
  let at = 0;
  for (const match of matches) {
    const from = owner[match.index];
    let to = owner[match.index + match[0].length - 1] + 1;
    while (to < cells.length && cells[to].w === 0) to += 1;
    while (at < from) out.push(cells[at++]);
    for (const char of [...replacement]) {
      const width = cellWidth(char.codePointAt(0));
      out.push({ ...cells[from], ch: char, w: width });
      if (width === 2) out.push({ ...cells[from], ch: "", w: 0 });
    }
    at = to;
  }
  while (at < cells.length) out.push(cells[at++]);
  while (out.length < cells.length) out.push({ ch: "", w: 1, fg: -1, bg: -1 });
  return out.slice(0, cells.length);
}

export function maskSnapshot(snapshot, rules) {
  return { ...snapshot, rows: snapshot.rows.map((cells) => rules.reduce(maskRow, cells)) };
}

// The rules for one recording: the defaults plus whatever it asks to mask (the signed-in login).
export function maskRulesFor(header) {
  return maskRules({
    extra: (header.mask ?? []).map(({ literal: value, text }) => ({ pattern: new RegExp(literal(value), "g"), text })),
  });
}

// ---------------------------------------------------------------- drawing

const hex2 = (n) => n.toString(16).padStart(2, "0");
const cube = (v) => (v ? 55 + v * 40 : 0);
export const PALETTE = Object.freeze([
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
  ...Array.from({ length: 216 }, (_, i) => `#${hex2(cube(Math.floor(i / 36)))}${hex2(cube(Math.floor(i / 6) % 6))}${hex2(cube(i % 6))}`),
  ...Array.from({ length: 24 }, (_, i) => `#${hex2(8 + i * 10).repeat(3)}`),
]);

export const THEME = Object.freeze({ fg: "#e6e6e3", bg: "#16161a", font: 15, row: 22 });
const FONT_STACK = "Menlo, 'SF Mono', 'Apple SD Gothic Neo', monospace";

const paint = (value, fallback) => (value === -1 ? fallback : Number.isInteger(value) && value >= 0 && value < 256 ? PALETTE[value] : /^#[0-9a-f]{6}$/.test(value) ? value : fallback);
const mix = (a, b) => `#${[1, 3, 5].map((i) => hex2(Math.round((parseInt(a.slice(i, i + 2), 16) + parseInt(b.slice(i, i + 2), 16)) / 2))).join("")}`;
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function styleOf(cell) {
  let fg = paint(cell.fg, THEME.fg);
  let bg = paint(cell.bg, null);
  if (cell.inverse) [fg, bg] = [bg ?? THEME.bg, fg];
  if (cell.dim) fg = mix(fg, bg ?? THEME.bg);
  if (cell.invisible) fg = bg ?? THEME.bg;
  return { fg, bg, bold: cell.bold, italic: cell.italic, underline: cell.underline, strike: cell.strike };
}

const sameStyle = (a, b) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;
const isPlain = (char) => char.length === 1 && char.charCodeAt(0) < 0x7f;

// One screen as absolutely positioned pieces on a fixed grid (1 column = 1ch), so
// glyphs from fallback fonts cannot push later columns out of place.
export function screenHtml(snapshot, { showCursor = false } = {}) {
  const pieces = [];
  snapshot.rows.forEach((cells, y) => {
    const top = y * THEME.row;
    let x = 0;
    while (x < cells.length) {
      if (cells[x].w === 0) {
        x += 1;
        continue;
      }
      const style = styleOf(cells[x]);
      let end = x;
      let plain = true;
      while (end < cells.length) {
        if (cells[end].w === 0) {
          end += 1;
          continue;
        }
        if (!sameStyle(style, styleOf(cells[end]))) break;
        if (!isPlain(cells[end].ch || " ")) plain = false;
        end += cells[end].w;
      }
      const css = [`color:${style.fg}`];
      if (style.bold) css.push("font-weight:700");
      if (style.italic) css.push("font-style:italic");
      if (style.underline || style.strike) css.push(`text-decoration:${[style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ")}`);
      if (style.bg) pieces.push(`<i style="top:${top}px;left:${x}ch;width:${end - x}ch;background:${style.bg}"></i>`);
      if (plain) {
        const text = cells.slice(x, end).map((cell) => cell.ch || " ").join("");
        if (text.trim() !== "") pieces.push(`<b style="top:${top}px;left:${x}ch;${css.join(";")}">${escapeHtml(text)}</b>`);
      } else {
        // Any glyph that may come from another font sits alone in its own column.
        for (let at = x; at < end; at += 1) {
          const cell = cells[at];
          if (cell.w === 0 || !cell.ch || cell.ch === " ") continue;
          const wide = cell.w === 2 ? ";width:2ch;text-align:center" : "";
          pieces.push(`<b style="top:${top}px;left:${at}ch;${css.join(";")}${wide}">${escapeHtml(cell.ch)}</b>`);
        }
      }
      x = end;
    }
  });
  if (showCursor && !snapshot.cursor.hidden) {
    pieces.push(`<i class="cur" style="top:${snapshot.cursor.y * THEME.row}px;left:${snapshot.cursor.x}ch;width:1ch"></i>`);
  }
  return `<div class="grid" style="width:${snapshot.cols}ch;height:${snapshot.rows.length * THEME.row}px">${pieces.join("")}</div>`;
}

export const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
.grid{position:relative;font:${THEME.font}px/${THEME.row}px ${FONT_STACK};color:${THEME.fg};white-space:pre}
.grid b{position:absolute;height:${THEME.row}px;font-weight:400;white-space:pre}
.grid i{position:absolute;height:${THEME.row}px}
.grid .cur{background:#e6e6e3;opacity:.85}
`;

// A still for the guide: the screen in a window with a title bar.
export function stillPage(snapshot, { title = "Terminal", showCursor = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
.win{display:inline-block;background:${THEME.bg};border-radius:12px;overflow:hidden;border:1px solid #3a3a42}
.bar{height:34px;background:#26262c;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid #34343c}
.bar span{width:12px;height:12px;border-radius:50%;display:inline-block}
.bar em{flex:1;text-align:center;color:#a8a8b0;font:13px -apple-system,'Apple SD Gothic Neo',sans-serif;font-style:normal;margin-right:44px}
.body{padding:12px 16px 14px}
</style></head><body><div class="win" id="win"><div class="bar"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span><em>${escapeHtml(title)}</em></div><div class="body">${screenHtml(snapshot, { showCursor })}</div></div></body></html>`;
}

// One video frame: the screen, a caption bar, and an optional speed badge.
export function framePage(snapshot, { width, height, caption = "", step = "", badge = "", showCursor = true }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
body{width:${width}px;height:${height}px;background:#0e0e11;position:relative;overflow:hidden}
.term{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:${THEME.bg};border:1px solid #2c2c33;border-radius:8px;padding:6px 8px}
.cap{position:absolute;left:0;right:0;bottom:0;height:58px;background:#1b1b21;border-top:1px solid #34343c;display:flex;align-items:center;gap:14px;padding:0 28px;font:600 22px -apple-system,'Apple SD Gothic Neo',sans-serif;color:#f3f3f1}
.cap .n{background:#7c5cff;color:#fff;border-radius:999px;padding:3px 14px;font-size:18px}
.badge{position:absolute;right:22px;top:16px;background:#7c5cffdd;color:#fff;border-radius:8px;padding:4px 12px;font:600 16px -apple-system,sans-serif}
</style></head><body><div class="term">${screenHtml(snapshot, { showCursor })}</div>${badge ? `<div class="badge">${escapeHtml(badge)}</div>` : ""}<div class="cap">${step ? `<span class="n">${escapeHtml(step)}</span>` : ""}<span>${escapeHtml(caption)}</span></div></body></html>`;
}

export function titleCardPage({ width, height, step, title, subtitle }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}
body{width:${width}px;height:${height}px;background:linear-gradient(135deg,#17142b,#0e0e11 60%);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;color:#f3f3f1}
.s{background:#7c5cff;border-radius:999px;padding:6px 20px;font-weight:600;font-size:24px;margin-bottom:26px}
h1{font-size:64px;margin:0 0 18px;font-weight:700;letter-spacing:-1px}
p{font-size:28px;margin:0;color:#b8b8c4}
</style></head><body>${step ? `<div class="s">${escapeHtml(step)}</div>` : ""}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle ?? "")}</p></body></html>`;
}

// ---------------------------------------------------------------- browser

export async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const installed = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()
      .map((name) => path.join(cache, name, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"))
    : [];
  const executablePath = process.env.CHROMIUM_PATH ?? installed.find((file) => fs.existsSync(file));
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
