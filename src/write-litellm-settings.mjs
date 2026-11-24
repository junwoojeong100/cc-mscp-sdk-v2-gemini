import { writeGatewaySettings } from "./claude-gateway-env.mjs";
import { litellmModels } from "./litellm-runtime.mjs";
import { PRIMARY_MODELS, FAMILY_MODELS, modelDisplayName } from "./model-map.mjs";

// Claude Code settings for a session that goes through LiteLLM. The key comes
// only from the environment: argv is readable by every local user.
const [outputPath, baseUrlValue, model, ...extra] = process.argv.slice(2);
const token = process.env.LITELLM_API_KEY;

if (!outputPath || !baseUrlValue || !model || extra.length || !token?.trim()) {
  console.error(
    "Usage: LITELLM_API_KEY=... node src/write-litellm-settings.mjs <output> <base-url> <model>",
  );
  process.exit(2);
}

let baseUrl;
try {
  const parsed = new URL(baseUrlValue);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http or https");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("URL must not contain a query string or fragment");
  }
  if (parsed.pathname.replace(/\/+$/, "").endsWith("/v1")) {
    throw new Error("URL must not end in /v1; Claude Code appends /v1/messages");
  }
  baseUrl = baseUrlValue.replace(/\/+$/, "");
} catch (error) {
  console.error(`Invalid LiteLLM base URL: ${error.message}`);
  process.exit(2);
}

// The aliases LiteLLM serves, so the picker lists what a request can reach. A gateway
// that cannot be reached, rejects the key or does not serve the model would fail on
// the first request, so it stops here with the reason.
function die(message, hint) {
  console.error(`${message}\n${hint}`);
  process.exit(1);
}

const served = await litellmModels(baseUrl, token);
if (!served.ok) {
  if (served.status === 0) die(`Cannot reach LiteLLM at ${baseUrl} (${served.error}).`, "Start it with: gemini-litellm up");
  if (served.status === 401 || served.status === 403) die("LiteLLM rejected the key.", "Use the gateway's master or virtual key (LITELLM_API_KEY).");
  die(`LiteLLM answered ${served.status} to GET /v1/models.`, "Check the gateway URL and its log.");
}
if (!served.ids.includes(model)) {
  die(`LiteLLM does not serve "${model}". It serves: ${served.ids.join(", ") || "no models"}.`, "Pick one of them with --litellm-model.");
}
const aliases = [...new Set([...PRIMARY_MODELS.filter((id) => served.ids.includes(id)), model])];
const label = (id) => `LiteLLM · ${modelDisplayName(id) === id ? id : `${modelDisplayName(id)} (${id})`}`;

// Claude Code's own aliases (opus, sonnet, haiku) stay inside the Gemini 4 family,
// the same split the direct path uses. A gateway that lacks one of those models
// sends that alias to the model the session started on.
const familyModels = Object.fromEntries(
  Object.entries(FAMILY_MODELS).map(([family, id]) => [family, served.ids.includes(id) ? id : model]),
);
const familyNames = Object.fromEntries(
  Object.entries(familyModels).map(([family, id]) => [family, `LiteLLM · ${modelDisplayName(id)}`]),
);

writeGatewaySettings(outputPath, {
  baseUrl,
  token,
  model,
  modelPicker: {
    replaceBuiltInOptions: true,
    options: aliases.map((id) => ({ model: id, label: label(id), description: "Routed through LiteLLM" })),
  },
  familyModels,
  displayNames: { ...familyNames, custom: `LiteLLM · ${modelDisplayName(model)}` },
  description: "Routed through LiteLLM",
  extraEnv: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  },
});
