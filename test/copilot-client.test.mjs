import assert from "node:assert/strict";
import test from "node:test";

import { STREAM_RECOVERY_FLAG, copilotClientOptions, createCopilotClient, runtimeEnvironment } from "../src/copilot-client.mjs";

test("keeps the runtime in a child process instead of SDK 2's in-process default", () => {
  const options = copilotClientOptions({ baseDirectory: "/tmp/copilot-home", logLevel: "error", env: {} });
  assert.equal(options.mode, "empty");
  assert.equal(options.runtime.kind, "spawned-stdio");
  assert.equal(options.runtime.baseDirectory, "/tmp/copilot-home");
  assert.deepEqual(options.observability, { logLevel: "error" });
});

test("the runtime it starts retries a model call that came back empty", () => {
  assert.equal(runtimeEnvironment({ PATH: "/bin" }).COPILOT_CLI_ENABLED_FEATURE_FLAGS, STREAM_RECOVERY_FLAG);
  assert.equal(runtimeEnvironment({ PATH: "/bin" }).PATH, "/bin");
  // Flags the user already enabled stay, and it is not listed twice.
  assert.equal(runtimeEnvironment({ COPILOT_CLI_ENABLED_FEATURE_FLAGS: "other_flag" }).COPILOT_CLI_ENABLED_FEATURE_FLAGS, `other_flag,${STREAM_RECOVERY_FLAG}`);
  assert.equal(runtimeEnvironment({ COPILOT_CLI_ENABLED_FEATURE_FLAGS: STREAM_RECOVERY_FLAG }).COPILOT_CLI_ENABLED_FEATURE_FLAGS, STREAM_RECOVERY_FLAG);
  // GHCP_STREAM_RECOVERY=0 leaves the decision to the runtime.
  assert.equal("COPILOT_CLI_ENABLED_FEATURE_FLAGS" in runtimeEnvironment({ GHCP_STREAM_RECOVERY: "0" }), false);
  assert.equal(copilotClientOptions({ baseDirectory: "/tmp", env: {} }).runtime.env.COPILOT_CLI_ENABLED_FEATURE_FLAGS, STREAM_RECOVERY_FLAG);
});

test("the installed SDK accepts these client options without starting a runtime", () => {
  const client = createCopilotClient({ baseDirectory: "/tmp/copilot-home", logLevel: "error" });
  assert.equal(typeof client.start, "function");
  assert.equal(typeof client.createSession, "function");
});
