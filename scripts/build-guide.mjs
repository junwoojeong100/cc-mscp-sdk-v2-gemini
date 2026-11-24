#!/usr/bin/env node
// Builds the guide page -- the whole hands-on guide as one self-contained page: guide.html,
// or with --via litellm guide-litellm.html.
//
// The track's template (guide/template.html, guide/litellm.template.html) is written by hand.
// This script fills in what must not be typed by hand: the screen captures (embedded), the
// model table and the verification result (both from the track's results file), and the video
// chapters.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trackNamed } from "./verify/tracks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const track = trackNamed(args.includes("--via") ? args[args.indexOf("--via") + 1] : "direct");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const results = JSON.parse(read(track.resultsFile));
const manifestFile = path.join(ROOT, track.assets, "media-manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { chapters: [] };

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const number = (value) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "-");
const short = (id) => id.replace("gemini-4-", "");
const title = (id) => short(id).replace(/^./, (c) => c.toUpperCase());

function dataUri(file) {
  const bytes = fs.readFileSync(file);
  const mime = file.endsWith(".png") ? "image/png" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const LAUNCHER = track.id === "litellm" ? "claude-gemini-litellm" : "claude-gemini";
const SCENARIO_NOTES = {
  answer: ["한글 응답", "정확한 한글 문장 응답 · 브리지가 요청한 모델 그대로 SDK가 처리 · 런타임이 카탈로그와 같은 긴 컨텍스트 한도를 부여"],
  effort: ["추론 강도", "--effort low / high / xhigh 가 실제 SDK 세션에 적용된 값과 일치 (xhigh 는 네 모델 모두 high 로 낮춰 적용)"],
  coding: ["코딩 (도구 사용)", "테스트 실행 → 원인 파악 → 소스만 수정 → 재실행, 테스트 파일 불변, 독립 재실행 4/4 통과"],
  vision: ["이미지 읽기", "Read 도구로 연 이미지의 5자리 숫자를 정확히 판독"],
  subagent: ["서브에이전트", "Explore 서브에이전트의 요청까지 같은 Gemini 모델로 처리"],
  switch: ["모델 전환", "도구 호출이 있던 대화를 다음 모델이 이어받아 도구 출력 회상"],
  launcher: ["런처 실행", `${LAUNCHER} -p 가 정답만 stdout 으로 출력`],
  tui: ["대화형 /model", "한 세션에서 4개 모델을 /model 로 전환, 각 응답을 해당 모델이 처리, 마지막 모델이 첫 모델에게 준 코드를 회상"],
  gateway: ["게이트웨이 명령", "gemini-litellm up → status → Claude Code 호출 → turns · logs → 토큰 수 요청이 LiteLLM 안에서 처리되고 Anthropic으로 나가지 않음 → down, 종료 뒤 남는 프로세스 없음"],
};
// What a case that is not one per model stands for in the table.
const SINGLE_CASE_NOTE = { tui: "한 세션에서 4개 모델 전환", gateway: "up · status · turns · logs · down" };

function verifyTable() {
  const models = results.models;
  const head = `<tr><th>시나리오</th>${models.map((id) => `<th>${title(id)}</th>`).join("")}<th>검사</th></tr>`;
  const scenarios = [...new Set(results.cases.map((entry) => entry.scenario))];
  const rows = scenarios.map((scenario) => {
    const entries = results.cases.filter((entry) => entry.scenario === scenario);
    const [name, note] = SCENARIO_NOTES[scenario] ?? [scenario, ""];
    const checks = entries.reduce((sum, entry) => sum + entry.checks.length, 0);
    let cells;
    if (entries.length === 1 && entries[0].model === null) {
      const entry = entries[0];
      cells = `<td colspan="${models.length}" class="${entry.ok ? "ok" : "bad"}">${entry.ok ? "✓" : "✗"} ${SINGLE_CASE_NOTE[scenario] ?? "한 세션"} <small>${entry.seconds.toFixed(0)}초</small></td>`;
    } else {
      cells = models.map((model) => {
        const entry = entries.find((item) => item.model === model);
        return entry ? `<td class="${entry.ok ? "ok" : "bad"}">${entry.ok ? "✓" : "✗"} <small>${entry.seconds.toFixed(1)}s</small></td>` : "<td>-</td>";
      }).join("");
    }
    return `<tr><th scope="row">${esc(name)}<small>${esc(note)}</small></th>${cells}<td class="num">${checks}</td></tr>`;
  });
  return `<table class="verify"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>`;
}

function verifySummary() {
  const { summary, environment: env } = results;
  const green = summary.passed === summary.cases && summary.invariantsOk;
  return `<div class="stat ${green ? "ok" : "bad"}"><b>${summary.passed}/${summary.cases}</b><span>케이스 통과</span></div>`
    + `<div class="stat"><b>${summary.checksPassed}/${summary.checks}</b><span>세부 검사 통과</span></div>`
    + `<div class="stat"><b>4/4</b><span>Gemini 4 모델</span></div>`
    + `<div class="stat"><b>${esc(env.claudeCode)}</b><span>Claude Code</span></div>`;
}

function verifyEnvironment() {
  const env = results.environment;
  const date = results.startedAt.slice(0, 10);
  const minutes = Math.round((Date.parse(results.finishedAt) - Date.parse(results.startedAt)) / 60000);
  return `<dl class="env"><dt>검증일</dt><dd>${date} (소요 약 ${minutes}분)</dd>`
    + `<dt>Claude Code</dt><dd>${esc(env.claudeCode)}</dd>`
    + `<dt>Copilot SDK</dt><dd>${esc(env.copilotSdkPackage)} ${esc(env.copilotSdk)} · 런타임 ${esc(env.copilotRuntime)}</dd>`
    + (env.litellm ? `<dt>LiteLLM</dt><dd>${esc(env.litellm)} (해시 고정 설치)</dd>` : "")
    + `<dt>Node.js</dt><dd>${esc(env.node)} · ${esc(env.platform)}</dd>`
    + `<dt>Copilot 인증</dt><dd>Copilot CLI 에 로그인된 사용자 계정(계정명은 기록하지 않음)</dd></dl>`;
}

// Gemini sometimes answers a call with nothing. The bridge reports that as an upstream overload so
// Claude Code retries; a case still has to end right to pass, so the page says how often it happened.
function verifyRetries() {
  const retries = results.summary.upstreamRetries ?? 0;
  if (!retries) return "";
  return `<p><small><b>업스트림 재시도 ${retries}건.</b> 검증 중 Gemini 4가 빈 응답을 돌려준 요청이 ${retries}건 있었습니다. 브리지가 이를 재시도 가능한 오류(529)로 바꿨고, 재시도 끝에 해당 케이스는 모두 정상적으로 끝났습니다. 서비스 상태에 따라 횟수는 달라집니다.</small></p>`;
}

function verifyInvariants() {
  return `<ul class="invariants">${results.invariants.map((item) => `<li class="${item.ok ? "ok" : "bad"}">${item.ok ? "✓" : "✗"} ${esc(item.name.replace("no session was written to the real ~/.claude/projects", "실제 ~/.claude/projects 에 세션이 쓰이지 않음").replace("no bridge process is left running", "실행 후 남은 브리지 프로세스 없음").replace("no LiteLLM process is left running", "실행 후 남은 LiteLLM 프로세스 없음").replace("~/.claude/settings.json was not touched", "~/.claude/settings.json 이 바뀌지 않음"))}</li>`).join("")}</ul>`;
}

function modelRows() {
  const answer = (id) => results.cases.find((entry) => entry.scenario === "answer" && entry.model === id);
  return results.environment.catalog.map((model) => {
    const seconds = answer(model.id)?.facts?.seconds;
    const note = model.notes.length ? `<span class="tag warn">${esc(model.notes[0].replace(/^Gemini 4 \w+ has a planned deprecation date of /, "지원 중단 예정 "))}</span>` : "";
    return `<tr><th scope="row"><code>${esc(model.id)}</code>${note}</th>`
      + `<td class="num">${number(model.contextWindow)}</td>`
      + `<td class="num">${number(model.maxPrompt)}</td>`
      + `<td class="num">${number(model.maxOutput)}</td>`
      + `<td>${model.vision ? "✓" : "-"}</td>`
      + `<td>${model.efforts.map((effort) => `<span class="chip${effort === "xhigh" ? " hot" : ""}">${effort}</span>`).join("")}</td>`
      + `<td class="num">${seconds ? `${seconds.toFixed(1)}s` : "-"}</td></tr>`;
  }).join("");
}

function effortRows() {
  return results.models.map((model) => {
    const entry = results.cases.find((item) => item.scenario === "effort" && item.model === model);
    const cell = (requested) => {
      const applied = entry?.facts?.[requested]?.applied;
      const lowered = applied && applied !== requested;
      return `<td class="${lowered ? "lowered" : ""}">${requested} → ${applied ?? "-"}${lowered ? " ↓" : ""}</td>`;
    };
    return `<tr><th scope="row"><code>${esc(model)}</code></th>${["low", "high", "xhigh"].map(cell).join("")}</tr>`;
  }).join("");
}

// Tokens the bridge counted over the cases that report them (not the launcher or the TUI case).
function tokenTotals() {
  const reporting = results.cases.filter((entry) => Number.isFinite(entry.facts?.inputTokens));
  return {
    input: reporting.reduce((sum, entry) => sum + entry.facts.inputTokens, 0),
    output: reporting.reduce((sum, entry) => sum + entry.facts.outputTokens, 0),
  };
}

const replacements = {
  "verify:table": verifyTable,
  "verify:summary": verifySummary,
  "verify:env": verifyEnvironment,
  "verify:invariants": verifyInvariants,
  "verify:retries": verifyRetries,
  "verify:tokens-in": () => number(tokenTotals().input),
  "verify:tokens-out": () => number(tokenTotals().output),
  "models:rows": modelRows,
  "effort:rows": effortRows,
  chapters: () => JSON.stringify(manifest.chapters),
  "video-length": () => {
    const seconds = Math.round((manifest.video?.seconds ?? 0) / 10) * 10;
    return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  },
  "case-count": () => String(results.summary.cases),
  "check-count": () => String(results.summary.checks),
  "claude-version": () => results.environment.claudeCode,
  "sdk-package": () => {
    const name = results.environment.copilotSdkPackage;
    if (!name) throw new Error(`${track.resultsFile} records no copilotSdkPackage: run the verification with --publish first`);
    return name;
  },
  // The folder a learner clones into is named after the repository, which is package.json's name.
  "repo-name": () => JSON.parse(read("package.json")).name,
  // Where the guides are published (GitHub Pages): package.json's homepage, always ending in a
  // slash. The guides link to each other, and fall back to the video, through it.
  "pages-url": () => {
    const { homepage } = JSON.parse(read("package.json"));
    if (!homepage) throw new Error("package.json has no homepage, the GitHub Pages address the guides link to");
    return homepage.endsWith("/") ? homepage : `${homepage}/`;
  },
  "sdk-version": () => results.environment.copilotSdk,
  "runtime-version": () => results.environment.copilotRuntime,
  "litellm-version": () => {
    const version = results.environment.litellm;
    if (!version) throw new Error(`${track.resultsFile} records no LiteLLM version: this placeholder belongs to the LiteLLM guide`);
    return version;
  },
  "verify-date": () => results.startedAt.slice(0, 10),
  poster: () => dataUri(path.join(ROOT, track.assets, "demo-poster.png")),
  "lab-image": () => dataUri(path.join(ROOT, "labs", "02-read-an-image", "code.png")),
};

let html = read(track.template);
html = html.replace(/\{\{img:([a-z0-9-]+)\}\}/g, (_, name) => {
  const file = path.join(ROOT, track.assets, "shots", `${name}.png`);
  if (!fs.existsSync(file)) throw new Error(`Missing screen capture: ${path.relative(ROOT, file)}`);
  return dataUri(file);
});
html = html.replace(/\{\{([a-z:-]+)\}\}/g, (match, key) => {
  if (!(key in replacements)) throw new Error(`Unknown placeholder ${match} in ${track.template}`);
  return replacements[key]();
});
fs.writeFileSync(path.join(ROOT, track.guide), html);
console.log(`${track.guide}  ${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB`);
