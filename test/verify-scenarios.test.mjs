import assert from "node:assert/strict";
import test from "node:test";

import { runsNodeTest } from "../scripts/verify/scenarios.mjs";

const bash = (command) => ({ name: "Bash", input: { command } });

test("a Bash line is a test run when node --test is one of its commands", () => {
  for (const command of ["node --test", "ls -la && node --test", "cd /tmp/lab; node --test 2>&1 | tail -20", "npm ci || node --test"]) {
    assert.equal(runsNodeTest(bash(command)), true, command);
  }
});

test("other lines and other tools are not test runs", () => {
  for (const command of ["ls -la", 'echo "node --test"', "npm test", "cat test/stats.test.mjs"]) {
    assert.equal(runsNodeTest(bash(command)), false, command);
  }
  assert.equal(runsNodeTest({ name: "Read", input: { file_path: "/tmp/node --test" } }), false);
  assert.equal(runsNodeTest({ name: "Bash", input: {} }), false);
});
