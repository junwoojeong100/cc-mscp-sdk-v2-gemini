import assert from "node:assert/strict";
import test from "node:test";

import {
  FAMILY_MODELS,
  ModelUnavailableError,
  PRIMARY_MODELS,
  ReasoningEffortUnavailableError,
  adapterModels,
  contextWindowTokensFor,
  copilotModelForFrontend,
  gatewayModelEntries,
  launchModelFor,
  pickerModelFor,
  primaryModelPicker,
  resolveCopilotModel,
  resolveReasoningEffort,
  sdkContextOptionsFor,
  stripContextSuffix,
  supportedReasoningEfforts,
} from "../src/model-map.mjs";

// The shape the Copilot catalog returned for these models on 2026-11-24.
const limits = (contextWindow, prompt, output) => ({
  max_context_window_tokens: contextWindow,
  max_prompt_tokens: prompt,
  max_output_tokens: output,
});
const catalog = {
  "gemini-4-argon": { id: "gemini-4-argon", name: "Gemini 4 Argon", supportedReasoningEfforts: ["low", "medium", "high"], capabilities: { limits: limits(1_048_576, 983_040, 65_536), supports: { reasoningEffort: true, reasoning_effort: ["low", "medium", "high"], vision: true } } },
  "gemini-4-carbon": { id: "gemini-4-carbon", name: "Gemini 4 Carbon", supportedReasoningEfforts: ["low", "medium", "high"], capabilities: { limits: limits(1_000_000, 936_000, 64_000), supports: { reasoningEffort: true, reasoning_effort: ["low", "medium", "high"], vision: true } } },
  "gemini-4-hydrogen": { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", supportedReasoningEfforts: ["low", "medium", "high"], capabilities: { limits: limits(1_048_576, 983_040, 65_536), supports: { reasoningEffort: true, reasoning_effort: ["low", "medium", "high", "xhigh"], vision: true } } },
  "gemini-4-neon": { id: "gemini-4-neon", name: "Gemini 4 Neon", supportedReasoningEfforts: ["low", "medium", "high"], capabilities: { limits: limits(1_048_576, 983_040, 65_536), supports: { reasoningEffort: true, reasoning_effort: ["low", "medium", "high", "xhigh"], vision: true } } },
};
const noEffort = { id: "plain-model", capabilities: { supports: {} } };

test("the four Gemini 4 models are the primary models", () => {
  assert.deepEqual([...PRIMARY_MODELS], ["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"]);
});

test("Claude Code sees a name with claude in it, and the bridge maps it back", () => {
  for (const id of PRIMARY_MODELS) {
    assert.equal(pickerModelFor(id), `github-copilot/claude-${id}`);
    assert.equal(launchModelFor(id), `github-copilot/claude-${id}[1m]`);
    assert.equal(copilotModelForFrontend(launchModelFor(id)), id);
  }
  assert.equal(stripContextSuffix("github-copilot/claude-gemini-4-neon[1m]"), "github-copilot/claude-gemini-4-neon");
  assert.equal(stripContextSuffix("x[200k]"), "x");
});

test("every Gemini 4 model has a 1M-class context window", () => {
  for (const id of PRIMARY_MODELS) assert.ok(contextWindowTokensFor(id) >= 1_000_000, id);
  assert.equal(contextWindowTokensFor("gpt-6-sol"), null);
});

test("model names resolve to Gemini 4 models, including Claude names and aliases", () => {
  const availableIds = [...PRIMARY_MODELS, "gpt-6-sol"];
  const resolve = (requested) => resolveCopilotModel({ requested, availableIds, preferredModel: "gemini-4-hydrogen" });
  assert.equal(resolve("gemini-4-argon"), "gemini-4-argon");
  assert.equal(resolve("github-copilot/claude-gemini-4-neon[1m]"), "gemini-4-neon");
  assert.equal(resolve("default"), "gemini-4-hydrogen");
  assert.equal(resolve(""), "gemini-4-hydrogen");
  assert.equal(resolve("opus"), FAMILY_MODELS.opus);
  assert.equal(resolve("sonnet"), FAMILY_MODELS.sonnet);
  assert.equal(resolve("haiku"), FAMILY_MODELS.haiku);
  assert.equal(resolve("claude-haiku-4-5-20251001"), FAMILY_MODELS.haiku);
  assert.equal(resolve("claude-3-5-haiku-latest"), FAMILY_MODELS.haiku);
  assert.equal(resolve("gpt-6-sol"), "gpt-6-sol");
});

test("an alias whose Gemini model is unavailable fails instead of picking another", () => {
  assert.throws(
    () => resolveCopilotModel({ requested: "opus", availableIds: ["gemini-4-argon"], preferredModel: null }),
    (error) => error instanceof ModelUnavailableError && /gemini-4-argon/.test(error.message),
  );
  assert.throws(() => resolveCopilotModel({ requested: "no-such-model", availableIds: PRIMARY_MODELS }), ModelUnavailableError);
});

test("the aliases are spread over Gemini 4 models only", () => {
  for (const id of Object.values(FAMILY_MODELS)) assert.ok(PRIMARY_MODELS.includes(id), id);
});

test("effort levels come from the top-level list the runtime checks, with the older lists as a fallback", () => {
  assert.deepEqual(supportedReasoningEfforts(catalog["gemini-4-argon"]), ["low", "medium", "high"]);
  // Runtime 1.0.113 rejects xhigh on Neon although its older array still names it.
  assert.deepEqual(supportedReasoningEfforts(catalog["gemini-4-neon"]), ["low", "medium", "high"]);
  assert.deepEqual(
    supportedReasoningEfforts({ id: "old", capabilities: { supports: { reasoning_effort: ["low", "high", "xhigh"] } } }),
    ["low", "high", "xhigh"],
  );
  assert.deepEqual(supportedReasoningEfforts(noEffort), []);
});

test("xhigh is lowered to high on all four models, which the runtime rejects it on", () => {
  const apply = (id, requested) => resolveReasoningEffort({ requested, model: catalog[id] });
  for (const id of PRIMARY_MODELS) assert.equal(apply(id, "xhigh"), "high", id);
});

test("other effort levels are applied or moved to the nearest listed level", () => {
  const apply = (id, requested) => resolveReasoningEffort({ requested, model: catalog[id] });
  assert.equal(apply("gemini-4-argon", "low"), "low");
  assert.equal(apply("gemini-4-argon", "medium"), "medium");
  assert.equal(apply("gemini-4-neon", "max"), "high");
  assert.equal(apply("gemini-4-argon", "max"), "high");
  assert.equal(apply("gemini-4-argon", "none"), "low");
  assert.equal(resolveReasoningEffort({ requested: null, model: catalog["gemini-4-argon"] }), null);
});

test("a model without effort support gets none, and an unknown level is an error", () => {
  assert.equal(resolveReasoningEffort({ requested: "high", model: noEffort }), null);
  assert.throws(
    () => resolveReasoningEffort({ requested: "turbo", model: catalog["gemini-4-argon"] }),
    ReasoningEffortUnavailableError,
  );
});

test("the gateway list holds the Gemini 4 models only, with the 1M hint and display names", () => {
  const entries = gatewayModelEntries([...Object.values(catalog), { id: "gpt-6-sol", name: "GPT-6 Sol" }]);
  assert.deepEqual(entries.map((entry) => entry.backend_id), [...PRIMARY_MODELS]);
  assert.equal(entries[0].id, "github-copilot/claude-gemini-4-argon[1m]");
  assert.equal(entries[0].display_name, "GitHub Copilot · Gemini 4 Argon (gemini-4-argon)");
  assert.equal(entries[0].owned_by, "github-copilot");
  assert.deepEqual(adapterModels([{ id: "a" }, { id: "a" }, { id: "" }]).map((model) => model.id), ["a"]);
});

test("the SDK is asked for the long-context tier with the catalog's own limits", () => {
  assert.deepEqual(sdkContextOptionsFor(catalog["gemini-4-carbon"]), {
    contextTier: "long_context",
    modelCapabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 } },
  });
  assert.deepEqual(sdkContextOptionsFor({ id: "gpt-6-sol", capabilities: { limits: limits(1_000_000, 900_000, 32_000) } }), {});
  assert.deepEqual(sdkContextOptionsFor({ ...catalog["gemini-4-neon"], capabilities: { limits: limits(200_000, 190_000, 8_000) } }), {});
});

test("the /model picker lists the available Gemini 4 models, or all four when unknown", () => {
  const all = primaryModelPicker();
  assert.equal(all.replaceBuiltInOptions, true);
  assert.deepEqual(all.options.map((option) => option.model), PRIMARY_MODELS.map(launchModelFor));
  assert.equal(all.options[3].label, "GitHub Copilot · Gemini 4 Neon (gemini-4-neon)");
  const trimmed = primaryModelPicker(["gemini-4-carbon", "gemini-4-neon", "gpt-6-sol"]);
  assert.deepEqual(trimmed.options.map((option) => option.model), [launchModelFor("gemini-4-carbon"), launchModelFor("gemini-4-neon")]);
});
