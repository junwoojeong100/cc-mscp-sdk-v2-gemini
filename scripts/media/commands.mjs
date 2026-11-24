// What the recorded demo sessions type, in one place per track. The guide shows the
// same text, and test/guide.test.mjs checks that it does.

export const LAB_PROMPT = "node --test를 실행해서 실패하는 테스트의 원인을 찾고, 테스트 파일은 수정하지 말고 소스 파일만 고쳐서 모든 테스트가 통과하도록 해줘. 마지막에 node --test를 다시 실행해서 결과를 확인하고, 결과는 세 줄 이내로 요약해줘.";

const CAPITAL_QUESTION = "한국의 수도는 어디인가요? 한 단어로만 답해줘.";
const VISION_QUESTION = "code.png 파일을 읽고 이미지에 적힌 숫자만 답해줘.";
const MODELS = ["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"];

// `launch(args)` is how a user starts each launcher with a Gemini 4 model.
function launcherCommands(launcher, modelFlag) {
  const withModel = (model) => `${launcher} ${modelFlag} ${model}`;
  return {
    start: launcher,
    printOne: `${withModel("gemini-4-hydrogen")} -p "${CAPITAL_QUESTION}"`,
    printEach: `for m in ${MODELS.join(" ")}; do echo "== $m"; ${launcher} ${modelFlag} "$m" -p "${CAPITAL_QUESTION}" 2>/dev/null; done`,
    codingLaunch: `${withModel("gemini-4-neon")} --permission-mode acceptEdits --allowedTools "Bash(node --test)"`,
    vision: `${withModel("gemini-4-neon")} -p "${VISION_QUESTION}"`,
  };
}

export const COMMANDS = Object.freeze({
  direct: Object.freeze({
    ...launcherCommands("claude-gemini", "--ghcp-model"),
    doctor: "gemini-doctor",
    turns: "claude-gemini-turns",
    status: "claude-gemini-status",
    stop: "claude-gemini-stop",
    verifyReport: "npm run --silent verify:report",
  }),
  litellm: Object.freeze({
    ...launcherCommands("claude-gemini-litellm", "--litellm-model"),
    doctor: "gemini-doctor --litellm",
    // The gateway: LiteLLM in front of the bridge.
    setup: "gemini-litellm setup",
    up: "gemini-litellm up",
    gatewayStatus: "gemini-litellm status",
    turns: "gemini-litellm turns",
    logs: "gemini-litellm logs",
    stop: "gemini-litellm down",
    verifyReport: "npm run --silent verify:litellm:report",
  }),
});
