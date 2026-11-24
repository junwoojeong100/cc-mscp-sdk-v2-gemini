import { launchModelFor } from "../../src/model-map.mjs";

// The two ways Claude Code reaches the bridge, each with its own verification,
// recordings and guide. `direct` is the claude-gemini launcher's path; `litellm`
// puts the LiteLLM gateway in between. A scenario asks its track for the model
// name Claude Code is started with and the name the bridge then sees; the media
// and guide builders ask it where the track's files live.
export const TRACKS = Object.freeze({
  direct: Object.freeze({
    id: "direct",
    resultsFile: "verification/results.json",
    recordings: ".media/recordings",
    assets: "assets",
    template: "guide/template.html",
    guide: "guide.html",
    clientModel: launchModelFor,
    requestedModel: (id) => `github-copilot/claude-${id}`,
    launcher: "bin/claude-gemini",
    // What the welcome header and the /model picker call a model.
    label: "GitHub Copilot",
  }),
  litellm: Object.freeze({
    id: "litellm",
    resultsFile: "verification/results-litellm.json",
    recordings: ".media/recordings-litellm",
    assets: "assets/litellm",
    template: "guide/litellm.template.html",
    guide: "guide-litellm.html",
    clientModel: (id) => id,
    requestedModel: (id) => id,
    launcher: "bin/claude-gemini-litellm",
    label: "LiteLLM",
  }),
});

export function trackNamed(id) {
  const track = TRACKS[id];
  if (!track) throw new Error(`Unknown track "${id}". Choose from: ${Object.keys(TRACKS).join(", ")}`);
  return track;
}
