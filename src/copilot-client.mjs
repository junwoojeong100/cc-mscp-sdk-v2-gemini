import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";

// SDK 2 hosts the runtime inside the calling process by default. The bridge
// keeps it in a child process, as SDK 1 did, so the runtime's lifetime, its
// environment and a crash stay separate from the bridge's own.
//
// Gemini 4 sometimes answers a model call with nothing at all (the runtime logs
// a model_stream_interruption of kind empty_response). The runtime can retry such
// a call, but only when its STREAM_INTERRUPTION_RECOVERY feature (experiment
// variable copilot_cli_stream_interruption_recovery) is on, which GitHub's
// experimentation service does not do for every account. The bridge turns it on
// for the runtime it starts; GHCP_STREAM_RECOVERY=0 leaves the decision to the
// runtime.
export const STREAM_RECOVERY_FLAG = "STREAM_INTERRUPTION_RECOVERY";

export function runtimeEnvironment(env = process.env) {
  const flags = (env.COPILOT_CLI_ENABLED_FEATURE_FLAGS ?? "").split(",").map((flag) => flag.trim()).filter(Boolean);
  if (env.GHCP_STREAM_RECOVERY !== "0" && !flags.includes(STREAM_RECOVERY_FLAG)) flags.push(STREAM_RECOVERY_FLAG);
  return { ...env, ...(flags.length ? { COPILOT_CLI_ENABLED_FEATURE_FLAGS: flags.join(",") } : {}) };
}

export function copilotClientOptions({ baseDirectory, logLevel, env = process.env } = {}) {
  return {
    mode: "empty",
    runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory, env: runtimeEnvironment(env) }),
    observability: { logLevel },
  };
}

export function createCopilotClient(options) {
  return new CopilotClient(copilotClientOptions(options));
}
