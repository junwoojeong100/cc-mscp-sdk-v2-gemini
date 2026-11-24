// The four Gemini 4 models GitHub Copilot serves. The IDs are Copilot catalog
// IDs, as `bin/gemini-models` lists them for the signed-in account.
const PRIMARY_MODEL_NAMES = Object.freeze({
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-4-carbon": "Gemini 4 Carbon",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-4-neon": "Gemini 4 Neon",
});

export const PRIMARY_MODELS = Object.freeze(Object.keys(PRIMARY_MODEL_NAMES));

// Claude Code's own aliases (opus, sonnet, haiku) are pinned to Gemini 4 models,
// so nothing Claude Code sends on its own -- small background tasks, subagents
// that name an alias -- can leave the Gemini 4 family. The split follows the
// catalog's token price (hydrogen lowest, neon highest), not a quality ranking.
export const FAMILY_MODELS = Object.freeze({
  opus: "gemini-4-neon",
  sonnet: "gemini-4-carbon",
  haiku: "gemini-4-hydrogen",
});

const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;
// Claude Code keeps a gateway-listed model only when its ID contains "claude"
// or "anthropic", so the name it sees carries "claude-" after the provider.
const COPILOT_PICKER_PREFIX = "github-copilot/claude-";
const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
// Context windows Claude Code may budget through a `[1m]` hint, as the Copilot
// catalog advertised them for these models.
const MODEL_CONTEXT_WINDOW_TOKENS = new Map([
  ["gemini-4-argon", 1_048_576],
  ["gemini-4-carbon", 1_000_000],
  ["gemini-4-hydrogen", 1_048_576],
  ["gemini-4-neon", 1_048_576],
]);

function isAdapterModelId(modelId) {
  return typeof modelId === "string" && modelId.length > 0;
}

export class ModelUnavailableError extends Error {
  constructor(requested, availableIds) {
    const supportedIds = [...new Set(availableIds.filter(isAdapterModelId))];
    super(
      `GitHub Copilot model "${requested}" is unavailable. ` +
        `Available adapter models: ${supportedIds.join(", ") || "none"}.`,
    );
    this.name = "ModelUnavailableError";
  }
}

export class ReasoningEffortUnavailableError extends Error {
  constructor(requested, modelId, supported) {
    super(
      `GitHub Copilot model "${modelId}" does not support reasoning effort "${requested}". ` +
        `Supported reasoning efforts: ${supported.join(", ") || "none"}.`,
    );
    this.name = "ReasoningEffortUnavailableError";
  }
}

export function modelDisplayName(modelId) {
  return PRIMARY_MODEL_NAMES[modelId] ?? modelId;
}

export function stripContextSuffix(model) {
  return String(model || "").trim().replace(/\[(?:1m|\d+k)\]$/i, "");
}

// Claude Code spells Claude versions with dashes (claude-sonnet-4-5); Copilot
// uses dots. Gemini IDs contain no version dot and pass through unchanged.
export function frontendModelFor(copilotModel) {
  const model = stripContextSuffix(copilotModel);
  return model.replace(
    /^(claude-(?:haiku|sonnet|opus))-(\d+)\.(\d+)$/,
    "$1-$2-$3",
  );
}

// The name Claude Code sees for a Copilot model: Claude IDs keep their own
// spelling, every other model gets the prefix.
export function pickerModelFor(copilotModel) {
  const model = stripContextSuffix(copilotModel);
  if (model.startsWith(COPILOT_PICKER_PREFIX)) return model;
  return model.startsWith("claude-")
    ? frontendModelFor(model)
    : `${COPILOT_PICKER_PREFIX}${model}`;
}

export function copilotModelForFrontend(frontendModel) {
  const model = stripContextSuffix(frontendModel);
  if (model.startsWith(COPILOT_PICKER_PREFIX)) {
    return model.slice(COPILOT_PICKER_PREFIX.length);
  }
  return model.replace(
    /^(claude-(?:haiku|sonnet|opus))-(\d+)-(\d+)$/,
    "$1-$2.$3",
  );
}

export function resolveCopilotModel({
  requested,
  availableIds,
  preferredModel,
}) {
  const available = new Set(availableIds);
  const raw = stripContextSuffix(requested);

  if (
    (!raw || raw === "default") &&
    preferredModel &&
    available.has(preferredModel)
  ) {
    return preferredModel;
  }
  if (available.has(raw)) return raw;

  const converted = copilotModelForFrontend(raw);
  if (available.has(converted)) return converted;

  // A Claude model or alias name (opus, sonnet, haiku, claude-haiku-4-5-...)
  // goes to the Gemini 4 model pinned to that family.
  const family = raw.toLowerCase().match(/(?:^|[^a-z])(opus|sonnet|haiku)(?:[^a-z]|$)/)?.[1];
  if (family && available.has(FAMILY_MODELS[family])) return FAMILY_MODELS[family];

  throw new ModelUnavailableError(requested, availableIds);
}

// A model can list its efforts in three places. The runtime checks a requested
// level against the top-level `supportedReasoningEfforts`: runtime 1.0.113
// rejects xhigh on all four Gemini 4 models, although Hydrogen's and Neon's
// older `capabilities.supports.reasoning_effort` array still names it. The
// other two lists only stand in for an entry that has no top-level list. A
// level the chosen list does not name is lowered to the nearest one it does.
export function supportedReasoningEfforts(model) {
  const lists = [
    model?.supportedReasoningEfforts,
    model?.capabilities?.supportedReasoningEfforts,
    model?.capabilities?.supports?.reasoning_effort,
  ];
  const listed = new Set(lists.find((list) => Array.isArray(list) && list.length > 0));
  return REASONING_EFFORT_LEVELS.filter((effort) => listed.has(effort));
}

export function resolveReasoningEffort({ requested, model }) {
  if (!requested) return null;

  const supported = supportedReasoningEfforts(model);
  const configurable =
    model?.capabilities?.supports?.reasoningEffort ?? supported.length > 0;

  if (!configurable) return null;
  if (!supported.length || supported.includes(requested)) return requested;

  const requestedIndex = REASONING_EFFORT_LEVELS.indexOf(requested);
  if (requestedIndex < 0) {
    throw new ReasoningEffortUnavailableError(
      requested,
      model?.id || "unknown",
      supported,
    );
  }

  return (
    supported.findLast(
      (effort) => REASONING_EFFORT_LEVELS.indexOf(effort) <= requestedIndex,
    ) ??
    supported[0] ??
    null
  );
}

export function adapterModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (!isAdapterModelId(model.id) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function gatewayPickerId(model) {
  const pickerId = pickerModelFor(model.id);
  const contextWindowTokens =
    model.capabilities?.limits?.max_context_window_tokens;
  return contextWindowTokens >= ONE_MILLION_CONTEXT_TOKENS
    ? `${pickerId}[1m]`
    : pickerId;
}

function gatewayDisplayName(model) {
  const name = model.name || model.id;
  const label = name === model.id ? name : `${name} (${model.id})`;
  return `GitHub Copilot · ${label}`;
}

export function gatewayModelEntries(models) {
  return adapterModels(models)
    .filter((model) => PRIMARY_MODELS.includes(model.id))
    .map((model) => ({
      id: gatewayPickerId(model),
      backend_id: model.id,
      display_name: gatewayDisplayName(model),
      object: "model",
      owned_by: "github-copilot",
      capabilities: model.capabilities,
    }));
}

export function contextWindowTokensFor(model) {
  const copilotModel = copilotModelForFrontend(model);
  return MODEL_CONTEXT_WINDOW_TOKENS.get(copilotModel) ?? null;
}

export function sdkContextOptionsFor(model) {
  const advertised = model?.capabilities?.limits;
  if (!MODEL_CONTEXT_WINDOW_TOKENS.has(model?.id) ||
      !Number.isSafeInteger(advertised?.max_context_window_tokens) ||
      advertised.max_context_window_tokens < ONE_MILLION_CONTEXT_TOKENS) return {};
  const limits = Object.fromEntries(
    ["max_context_window_tokens", "max_prompt_tokens", "max_output_tokens"]
      .filter((name) => Number.isSafeInteger(advertised[name]) && advertised[name] > 0)
      .map((name) => [name, advertised[name]]),
  );
  // The runtime's default tier can be much smaller than the model catalogue.
  return { contextTier: "long_context", modelCapabilities: { limits } };
}

export function launchModelFor(model) {
  const backend = copilotModelForFrontend(model);
  return contextWindowTokensFor(backend) >= ONE_MILLION_CONTEXT_TOKENS
    ? `${pickerModelFor(backend)}[1m]`
    : frontendModelFor(backend);
}

// `availableIds` (the live catalog) trims the picker to models this account can
// actually call; without it every Gemini 4 model is listed.
export function primaryModelPicker(availableIds) {
  const available = availableIds ? new Set(availableIds) : null;
  return {
    replaceBuiltInOptions: true,
    options: PRIMARY_MODELS.filter((id) => !available || available.has(id)).map((id) => ({
      model: launchModelFor(id),
      label: gatewayDisplayName({ id, name: PRIMARY_MODEL_NAMES[id] }),
      description: "Routed through Microsoft Copilot SDK",
    })),
  };
}
