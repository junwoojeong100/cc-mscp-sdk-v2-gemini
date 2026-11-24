#!/usr/bin/env node
// Records the demo scenes the guide's screen captures and video are built from.
// Every scene is a real zsh session (and, inside it, a real Claude Code session) in a
// PTY: nothing is scripted output. It calls the Gemini 4 models, so it uses Copilot quota.
//
//   node scripts/media/record.mjs                    every scene
//   node scripts/media/record.mjs --scenes check,print
//   node scripts/media/record.mjs --via litellm      the LiteLLM track (installs LiteLLM into a scratch home)
//
// The captions carry the guide's STEP numbers, so the video and the page line up.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT, cleanEnv, resolveClaudeBin, sleep } from "../verify/lib.mjs";
import { trackNamed } from "../verify/tracks.mjs";
import { TuiSession, atPrompt, chooseModelForSession, reachPrompt } from "../verify/tui.mjs";
import { COMMANDS, LAB_PROMPT } from "./commands.mjs";

const COLS = 116;
const ROWS = 30;
const viaIndex = process.argv.indexOf("--via");
const track = trackNamed(viaIndex >= 0 ? process.argv[viaIndex + 1] : "direct");
const litellm = track.id === "litellm";
const cmd = COMMANDS[track.id];
// The guide numbers its steps; the LiteLLM guide has one more (starting the gateway).
const STEP = litellm
  ? { setup: "STEP 1", check: "STEP 2", gateway: "STEP 3", print: "STEP 4", firstRun: "STEP 5", switch: "STEP 6", coding: "STEP 7", vision: "STEP 8", cleanup: "STEP 9" }
  : { check: "STEP 2", print: "STEP 3", firstRun: "STEP 4", switch: "STEP 5", coding: "STEP 6", vision: "STEP 7", cleanup: "STEP 8" };
const OUT = path.join(ROOT, track.recordings);
const demoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-demo-")));
const configDir = path.join(demoRoot, "claude-config");
const daemonDir = path.join(demoRoot, "daemon");
// A scratch LiteLLM home, so the recording shows a real install and never touches a gateway in use.
const litellmHome = path.join(demoRoot, "runtime");
for (const dir of [configDir, daemonDir, OUT]) fs.mkdirSync(dir, { recursive: true });

// The other checkout's launchers (it ships a `claude` wrapper) must not be on the demo's PATH.
const cleanPath = process.env.PATH.split(":").filter((entry) => !entry.includes("claude-code-ghcp-sdk")).join(":");
const env = cleanEnv({
  PATH: `${path.join(ROOT, "bin")}:${cleanPath}`,
  CLAUDE_CONFIG_DIR: configDir,
  GHCP_DAEMON_DIR: daemonDir,
  ...(litellm ? { GEMINI_LITELLM_HOME: litellmHome } : {}),
  // Pinned to the versioned binary: Claude Code updates itself by moving a symlink, and
  // a recording must not change version halfway through.
  CLAUDE_CODE_BIN: fs.realpathSync(resolveClaudeBin()),
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  PS1: "%F{10}$%f ",
  HISTFILE: "/dev/null",
});

// The signed-in login is masked in every image, whatever it is, and so is the gateway's key.
const doctor = spawnSync(process.execPath, [path.join(ROOT, "src/doctor.mjs"), "--json"], { env, encoding: "utf8", timeout: 180_000 });
const login = JSON.parse(doctor.stdout || "{}").results?.find((item) => item.name.startsWith("Copilot sign-in: "))?.name.slice("Copilot sign-in: ".length);
if (!login) throw new Error("Not signed in to GitHub Copilot: run copilot login first.");
const masks = () => {
  const rules = [{ literal: login, text: "your-login" }];
  try {
    rules.push({ literal: fs.readFileSync(path.join(litellmHome, "litellm-master-key"), "utf8").trim(), text: "sk-…" });
  } catch {
    // No gateway key yet (or this is the direct track).
  }
  return rules;
};

const lastLine = (screen) => screen.split("\n").filter((line) => line.trim()).at(-1)?.trim() ?? "";
const atShell = (screen) => lastLine(screen) === "$";

async function shellScene(name, cwd, script) {
  const session = new TuiSession({ argv: ["/bin/zsh", "-f", "-i"], cwd, env, cols: COLS, rows: ROWS }).start();
  let failure = null;
  try {
    await session.waitFor(atShell, { label: "the shell prompt", timeoutMs: 30_000 });
    await script(session);
  } catch (error) {
    failure = error;
  } finally {
    await sleep(600);
    session.type("exit\r");
    await sleep(400);
    await session.stop();
  }
  // A partial recording is kept too: it shows where a failing scene stopped.
  const recording = session.recording();
  recording.header.mask = masks();
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(recording));
  console.log(`${failure ? "FAILED " : "recorded"} ${name}: ${recording.frames.length} frames, ${(session.frames.at(-1).t / 1000).toFixed(0)} s`);
  if (failure) throw failure;
}

const still = (session, name, title) => session.mark(`still:${name}|${title}`);
const caption = (session, step, text) => session.mark(`caption:${step}|${text}`);
const title = (session, step, heading, subtitle) => session.mark(`title:${step}|${heading}|${subtitle}`);
const hold = (session, ms) => session.mark(`hold:${ms}`);
// Ctrl-L: wipes what Claude Code left on screen when it exited ("Resume this session with…").
const clearScreen = async (session) => {
  session.type("\x0c");
  await sleep(400);
};

// Types a shell command and waits for the prompt to come back. `speed` plays the wait faster.
async function run(session, command, { speed = 1, timeoutMs = 240_000, after = 500 } = {}) {
  console.log(`  $ ${command.length > 90 ? `${command.slice(0, 87)}…` : command}`);
  await session.typeSlowly(command, { delayMs: 26 });
  await sleep(300);
  if (speed > 1) await session.mark(`speed:${speed}`);
  session.key("enter");
  await session.waitFor(atShell, { label: command, timeoutMs });
  if (speed > 1) await session.mark("speed:1");
  await sleep(after);
}

// Sends one prompt in Claude Code's TUI and waits until the answer is complete.
// With `permissions`, a permission question is answered with its first choice.
// `onProgress` runs once, when Claude Code first shows a file edit.
// A long turn scrolls the prompt out of the 30-row screen. In a fresh session (`firstTurn`)
// a completion line that is still on screen can only be this turn's, so it is enough.
async function ask(session, prompt, { speed = 1, timeoutMs = 240_000, permissions = false, firstTurn = false, onProgress } = {}) {
  console.log(`  ❯ ${prompt.slice(0, 40)}…`);
  await session.typeSlowly(prompt, { delayMs: 30 });
  await sleep(300);
  if (speed > 1) await session.mark(`speed:${speed}`);
  session.key("enter");
  const echo = prompt.slice(0, 10);
  const isDone = (line) => /^✻\s+\S+\s+for\s+\d/.test(line);
  const deadline = Date.now() + timeoutMs;
  let approved = 0;
  let progressed = false;
  for (;;) {
    await session.writeQueue;
    const screen = session.screen();
    const lines = screen.split("\n");
    const sent = lines.map((line, index) => (line.startsWith("❯ ") && line.includes(echo) ? index : -1)).filter((index) => index >= 0).at(-1);
    if (onProgress && !progressed && /^\s*⏺ (Update|Edit)\(/m.test(screen)) {
      progressed = true;
      await onProgress();
    }
    const finished = sent === undefined ? firstTurn && lines.some(isDone) : lines.slice(sent + 1).some(isDone);
    if (finished && !/esc to interrupt/.test(screen)) break;
    if (permissions && /Do you want to|Allow this|don't ask again/i.test(screen) && /^\s*❯\s+1\.\s+Yes/m.test(screen) && approved < 12) {
      approved += 1;
      await sleep(900);
      session.key("enter");
    }
    if (Date.now() > deadline) throw new Error(`No answer to "${prompt}" in time.\n${screen}`);
    await sleep(400);
  }
  if (speed > 1) await session.mark("speed:1");
  await sleep(600);
  return approved;
}

async function exitTui(session) {
  session.type("/exit");
  await sleep(500);
  session.key("enter");
  await session.waitFor(atShell, { label: "the shell after /exit", timeoutMs: 60_000 });
  await sleep(500);
}

const SCENES = {
  // LiteLLM track only: the one-time install of the gateway software.
  async setup() {
    await shellScene("00-setup", ROOT, async (s) => {
      await title(s, STEP.setup, "LiteLLM 설치", `${cmd.setup}  (처음 한 번)`);
      await caption(s, STEP.setup, "LiteLLM 을 이 저장소 안(.runtime)에 설치합니다 — 해시를 고정해 정확히 이 버전만 설치");
      await run(s, cmd.setup, { speed: 6, timeoutMs: 600_000 });
      await still(s, "setup", "Terminal — gemini-litellm setup");
      await hold(s, 3000);
    });
  },

  async check() {
    await shellScene("01-check", ROOT, async (s) => {
      await title(s, STEP.check, "환경 점검", `${cmd.doctor} · gemini-models`);
      await caption(s, STEP.check, litellm
        ? "gemini-doctor --litellm — ✓ 이면 준비 끝 (게이트웨이 '!' 는 아직 안 켜서 정상)"
        : "gemini-doctor — 모든 항목이 ✓ 이면 준비 끝");
      await run(s, cmd.doctor, { speed: 3 });
      await still(s, "doctor", `Terminal — ${cmd.doctor}`);
      await hold(s, 1800);
      await caption(s, STEP.check, "gemini-models — Gemini 4 모델 4개가 보여야 합니다");
      await run(s, "gemini-models", { speed: 2 });
      await still(s, "models", "Terminal — gemini-models");
      await hold(s, 3000);
    });
  },

  // LiteLLM track only: start the gateway (the bridge, then LiteLLM in front of it).
  async gateway() {
    await shellScene("01b-gateway", ROOT, async (s) => {
      await title(s, STEP.gateway, "게이트웨이 시작", `${cmd.up} · ${cmd.gatewayStatus}`);
      await caption(s, STEP.gateway, "gemini-litellm up — 브리지와 LiteLLM 을 차례로 켭니다");
      await run(s, cmd.up, { speed: 3, timeoutMs: 180_000 });
      await still(s, "gateway-up", "Terminal — gemini-litellm up");
      await hold(s, 2500);
      await caption(s, STEP.gateway, "status — LiteLLM·브리지가 켜져 있고 4개 별칭을 서빙하는지 확인");
      await run(s, cmd.gatewayStatus);
      await still(s, "gateway-status", "Terminal — gemini-litellm status");
      await hold(s, 3000);
    });
  },

  async print() {
    await shellScene("02-print", ROOT, async (s) => {
      await title(s, STEP.print, "첫 호출", `${cmd.start}  -p  (print 모드)`);
      await caption(s, STEP.print, "한 번 묻고 끝내는 print 모드 (-p)");
      await run(s, cmd.printOne, { speed: 4 });
      await still(s, "print-one", `Terminal — ${cmd.start} -p`);
      await hold(s, 2500);
      await caption(s, STEP.print, "4개 모델에 같은 질문 — 모두 응답해야 합니다");
      await run(s, cmd.printEach, { speed: 8, timeoutMs: 400_000 });
      await still(s, "print-four", "Terminal — 4개 모델 연속 호출");
      await hold(s, 3000);
    });
  },

  async firstRun() {
    await shellScene("03-first-run", ROOT, async (s) => {
      await title(s, STEP.firstRun, "대화형으로 시작", "처음 한 번만 나오는 Claude Code 첫 실행 화면");
      await caption(s, STEP.firstRun, `실습 폴더를 만들고 ${cmd.start} 실행`);
      await run(s, "gemini-lab 01 && cd /tmp/lab-01");
      await s.typeSlowly(cmd.start, { delayMs: 40 });
      await sleep(400);
      s.key("enter");
      const answered = new Set();
      const dialogs = [
        { id: "theme", seen: (screen) => /Choose the text style/.test(screen), key: "enter", caption: "테마 선택 → Enter", still: "first-theme", title: "Claude Code — 첫 실행 (1/4) 테마" },
        { id: "security", seen: (screen) => /Press Enter to continue/.test(screen), key: "enter", caption: "보안 안내 → Enter", still: "first-security", title: "Claude Code — 첫 실행 (2/4) 보안 안내" },
        { id: "terminal", seen: (screen) => /Use Claude Code's terminal setup\?/.test(screen), key: "escape", caption: "터미널 설정 제안은 Esc 로 건너뛰기", still: "first-terminal", title: "Claude Code — 첫 실행 (3/4) 터미널 설정" },
        { id: "trust", seen: (screen) => /trust this folder|Accessing workspace/i.test(screen) && /^\s*❯\s+No, exit/m.test(screen), key: "down", caption: "폴더 신뢰 — 기본 선택이 'No, exit' 이므로 ↓ 로 'Yes' 로 이동", still: "first-trust", title: "Claude Code — 첫 실행 (4/4) 폴더 신뢰" },
        { id: "trust-yes", seen: (screen) => /^\s*❯\s+Yes, I trust this folder/m.test(screen), key: "enter", caption: "'Yes, I trust this folder' 가 선택된 것을 확인하고 Enter", still: "first-trust-yes", title: "Claude Code — 폴더 신뢰: Yes 선택됨" },
      ];
      for (let tick = 0; tick < 80; tick += 1) {
        await s.writeQueue;
        const screen = s.screen();
        if (atPrompt(screen)) break;
        const dialog = dialogs.find((entry) => !answered.has(entry.id) && entry.seen(screen));
        if (dialog) {
          answered.add(dialog.id);
          await caption(s, STEP.firstRun, dialog.caption);
          await sleep(700);
          await still(s, dialog.still, dialog.title);
          await sleep(900);
          s.key(dialog.key);
        }
        await sleep(1_200);
      }
      await s.waitFor(atPrompt, { label: "Claude Code's prompt", timeoutMs: 60_000 });
      await sleep(800);
      await caption(s, STEP.firstRun, "프롬프트가 보이면 성공 — 헤더에 Gemini 4 Hydrogen 이 표시됩니다");
      await still(s, "tui-start", "Claude Code — Gemini 4 Hydrogen");
      await hold(s, 2500);
      await exitTui(s);
    });
  },

  async switch() {
    await shellScene("04-switch", "/tmp/lab-01", async (s) => {
      await title(s, STEP.switch, "/model 로 모델 바꾸기", "한 대화 안에서 Gemini 4 모델 4개를 모두 사용");
      await caption(s, STEP.switch, "대화형 모드 시작 (기본 모델: Gemini 4 Hydrogen)");
      await s.typeSlowly(cmd.start, { delayMs: 40 });
      await sleep(400);
      s.key("enter");
      await reachPrompt(s);
      await sleep(800);
      await caption(s, STEP.switch, "먼저 Hydrogen 에게 정보를 하나 알려줍니다");
      await ask(s, "내 이름은 지우야. 기억해줘. 짧게 답해줘.", { speed: 4 });
      await still(s, "chat-hydrogen", "Claude Code — Hydrogen 과 대화");
      await caption(s, STEP.switch, "/model 을 입력하면 모델 목록이 열립니다");
      const stages = {
        picker: () => still(s, "picker", "Claude Code — /model 목록 (Gemini 4 모델 4개)"),
        highlighted: async () => {
          await caption(s, STEP.switch, "↑/↓ 로 모델 선택 → s (이번 세션에서만). Enter 는 기본값으로 저장되니 주의");
          await still(s, "picker-select", "Claude Code — 모델을 고르고 s");
        },
        confirm: async () => {
          await caption(s, STEP.switch, "대화가 있으면 한 번 더 확인 — 'Yes, switch' 에서 Enter");
          await still(s, "switch-confirm", "Claude Code — 모델 전환 확인");
        },
      };
      await chooseModelForSession(s, "gemini-4-neon", { onStage: (stage) => stages[stage]?.() });
      await caption(s, STEP.switch, "전환한 Neon 이 앞선 대화(이름)를 기억합니다");
      await ask(s, "내 이름이 뭐라고 했지? 이름만 답해줘.", { speed: 4 });
      await still(s, "recall", "Claude Code — Neon 이 이전 대화를 기억");
      await hold(s, 2500);
      await caption(s, STEP.switch, "Argon, Carbon 으로도 이어서 전환");
      for (const [model, prompt] of [["gemini-4-argon", "지금까지 나눈 대화를 한 문장으로 요약해줘."], ["gemini-4-carbon", "내 이름을 한 번 더 말해줘. 이름만."]]) {
        await chooseModelForSession(s, model);
        await ask(s, prompt, { speed: 6 });
      }
      await still(s, "four-models", "Claude Code — 한 대화에서 4개 모델 사용");
      await hold(s, 2500);
      await caption(s, STEP.switch, `종료 후 ${cmd.turns} 로 실제로 응답한 모델 확인`);
      await exitTui(s);
      await clearScreen(s);
      await run(s, cmd.turns);
      await still(s, "turns", `Terminal — ${cmd.turns}`);
      await hold(s, 3500);
      if (litellm) {
        await caption(s, STEP.switch, "gemini-litellm logs — LiteLLM 이 요청마다 POST /v1/messages 200 으로 응답한 기록");
        await run(s, cmd.logs);
        await still(s, "litellm-log", "Terminal — gemini-litellm logs");
        await hold(s, 3500);
      }
    });
  },

  async coding() {
    await shellScene("05-coding", ROOT, async (s) => {
      await title(s, STEP.coding, "코딩 실습", "실패하는 테스트를 Gemini 가 고칩니다");
      await caption(s, STEP.coding, "실습 폴더 만들고, 먼저 테스트가 실패하는지 확인");
      await run(s, "gemini-lab 01 && cd /tmp/lab-01");
      await run(s, "node --test 2>&1 | grep -E '^(not ok|ok|# (tests|pass|fail))'");
      await still(s, "tests-fail", "Terminal — node --test (실패)");
      await hold(s, 2000);
      await caption(s, STEP.coding, "Gemini 4 Neon 으로 시작 — 파일 수정은 자동 승인, node --test 만 허용");
      await s.typeSlowly(cmd.codingLaunch, { delayMs: 22 });
      await sleep(400);
      s.key("enter");
      await reachPrompt(s);
      await sleep(600);
      await caption(s, STEP.coding, "프롬프트: 테스트 실행 → 원인 찾기 → 소스만 수정 → 재실행");
      const approved = await ask(s, LAB_PROMPT, {
        speed: 5, permissions: true, firstTurn: true, timeoutMs: 400_000,
        onProgress: () => still(s, "coding-working", "Claude Code — 작업 중: 소스 수정"),
      });
      console.log(`  (answered ${approved} permission questions)`);
      await caption(s, STEP.coding, "도구(Bash·Read·Edit) 사용 기록과 수정 내용(diff), 결과 요약이 화면에 남습니다");
      await still(s, "coding-done", "Claude Code — 테스트 수정 완료");
      await hold(s, 3500);
      await exitTui(s);
      await clearScreen(s);
      await caption(s, STEP.coding, "git diff — 실제로 무엇이 바뀌었는지 확인");
      await run(s, "git --no-pager diff");
      await still(s, "git-diff", "Terminal — git diff");
      await hold(s, 2500);
      await caption(s, STEP.coding, "테스트 재실행 — 모두 통과");
      await run(s, "node --test 2>&1 | grep -E '^(not ok|ok|# (tests|pass|fail))'");
      await still(s, "tests-pass", "Terminal — node --test (통과)");
      await hold(s, 3000);
    });
  },

  async vision() {
    await shellScene("06-vision", ROOT, async (s) => {
      await title(s, STEP.vision, "이미지 읽기", "Gemini 4 는 이미지를 이해합니다");
      await caption(s, STEP.vision, "실습 폴더 만들기 — code.png 한 장이 들어 있습니다");
      await run(s, "gemini-lab 02 && cd /tmp/lab-02 && ls");
      await caption(s, STEP.vision, "Read 도구가 이미지를 열면 Gemini 가 숫자를 읽습니다");
      await run(s, cmd.vision, { speed: 6 });
      await still(s, "vision", "Terminal — 이미지 속 숫자 읽기");
      await hold(s, 3000);
    });
  },

  async cleanup() {
    await shellScene("07-cleanup", ROOT, async (s) => {
      await title(s, STEP.cleanup, "정리", litellm ? "게이트웨이 확인과 종료" : "상주 브리지 확인과 종료");
      const statusCommand = litellm ? cmd.gatewayStatus : cmd.status;
      await caption(s, STEP.cleanup, litellm ? "게이트웨이(LiteLLM + 브리지) 상태 확인" : "대화형 세션이 남긴 상주 브리지 상태 확인");
      await run(s, statusCommand);
      await still(s, "status-running", `Terminal — ${statusCommand}`);
      await caption(s, STEP.cleanup, "더 쓰지 않으면 종료");
      await run(s, cmd.stop);
      await run(s, statusCommand);
      await still(s, "status-stopped", `Terminal — ${cmd.stop} 이후`);
      await hold(s, 2500);
    });
  },

  async verify() {
    await shellScene("08-verify", ROOT, async (s) => {
      await title(s, "검증", "검증 결과", "이 실습은 실제 호출로 검증했습니다");
      await caption(s, "검증", `${litellm ? "npm run verify:litellm:report" : "npm run verify:report"} — 기록된 검증 결과`);
      await run(s, cmd.verifyReport);
      await still(s, "verify-report", `Terminal — ${litellm ? "npm run verify:litellm:report" : "npm run verify:report"}`);
      await hold(s, 5000);
    });
  },
};

const order = litellm
  ? ["setup", "check", "gateway", "print", "firstRun", "switch", "coding", "vision", "cleanup", "verify"]
  : ["check", "print", "firstRun", "switch", "coding", "vision", "cleanup", "verify"];
const argIndex = process.argv.indexOf("--scenes");
const chosen = argIndex >= 0 ? process.argv[argIndex + 1].split(",") : order;
try {
  for (const name of order.filter((scene) => chosen.includes(scene))) {
    console.log(`> ${name}`);
    await SCENES[name]();
  }
} finally {
  try {
    execFileSync(path.join(ROOT, "bin", litellm ? "gemini-litellm" : "claude-gemini-stop"), litellm ? ["down"] : [], { env, stdio: "pipe", timeout: 60_000 });
  } catch {
    // Nothing was running.
  }
  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.rmSync("/tmp/lab-01", { recursive: true, force: true });
  fs.rmSync("/tmp/lab-02", { recursive: true, force: true });
}
