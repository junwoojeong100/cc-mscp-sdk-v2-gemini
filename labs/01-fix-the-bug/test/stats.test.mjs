import assert from "node:assert/strict";
import test from "node:test";

import { mean, median } from "../src/stats.mjs";

test("median of an odd count", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median of an even count", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("median sorts numbers by value, not as text", () => {
  assert.equal(median([10, 9, 2, 33, 4]), 9);
});

test("mean of several numbers", () => {
  assert.equal(mean([2, 4, 6]), 4);
});
