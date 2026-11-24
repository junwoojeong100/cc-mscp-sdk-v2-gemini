import { writeGatewaySettings } from "./claude-gateway-env.mjs";
import {
  FAMILY_MODELS,
  launchModelFor,
  modelDisplayName,
  primaryModelPicker,
} from "./model-map.mjs";

// The token comes only from the environment: argv is readable by every local
// user through the process table. A fourth argument is an old caller still
// passing the token there, so it fails instead of leaking.
const [outputPath, baseUrl, frontendModel, ...extra] = process.argv.slice(2);
const token = process.env.GHCP_BRIDGE_TOKEN;
if (!outputPath || !baseUrl || !frontendModel || extra.length || !token?.trim()) {
  console.error(
    "Usage: GHCP_BRIDGE_TOKEN=... node src/write-launch-settings.mjs <output> <base-url> <frontend-model>",
  );
  process.exit(2);
}

const nativeToolSearch = process.env.GHCP_NATIVE_TOOL_SEARCH ?? "0";
if (!["0", "1"].includes(nativeToolSearch)) {
  throw new Error("GHCP_NATIVE_TOOL_SEARCH must be 0 or 1.");
}

// The picker lists the Gemini 4 models this account can call. When the bridge
// does not answer, all four are listed rather than none.
async function availableModelIds() {
  try {
    const response = await fetch(new URL("/v1/models?all=true", baseUrl), {
      headers: { "x-api-key": token },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()).data.map((model) => model.id);
  } catch {
    return null;
  }
}

const familyModels = Object.fromEntries(
  Object.entries(FAMILY_MODELS).map(([family, id]) => [family, launchModelFor(id)]),
);
const familyNames = Object.fromEntries(
  Object.entries(FAMILY_MODELS).map(([family, id]) => [family, `GitHub Copilot ${modelDisplayName(id)}`]),
);

writeGatewaySettings(outputPath, {
  baseUrl,
  token,
  model: launchModelFor(frontendModel),
  modelPicker: primaryModelPicker(await availableModelIds()),
  // Same ids launchModelFor gives these models, `[1m]` included, so a launch on
  // one of them still matches its picker row and the alias carries the 1M window.
  familyModels,
  displayNames: {
    ...familyNames,
    custom: `GitHub Copilot ${modelDisplayName(frontendModel)}`,
  },
  description: "Routed through Microsoft Copilot SDK",
  extraEnv: {
    ENABLE_TOOL_SEARCH: nativeToolSearch === "1" ? "true" : "",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Context belongs to the selected model, not the model used at startup.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "",
  },
});
