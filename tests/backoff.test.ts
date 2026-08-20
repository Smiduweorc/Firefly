import assert from "node:assert/strict";
import { test } from "node:test";

import { constant, exponential, fromList } from "../index.js";

const none = { jitter: "none" } as const;

test("exponential grows by the factor and stops at max", () => {
	const schedule = exponential({ base: 100, max: 500, ...none });

	assert.deepEqual(
		[1, 2, 3, 4].map((attempt) => schedule(attempt)),
		[100, 200, 400, 500]
	);
});

test("exponential takes a factor other than two", () => {
	const schedule = exponential({ base: 10, factor: 3, ...none });

	assert.deepEqual(
		[1, 2, 3].map((attempt) => schedule(attempt)),
		[10, 30, 90]
	);
});

test("full jitter spreads the delay over the whole interval", () => {
	const schedule = exponential({ base: 1000, random: () => 0.25 });
	assert.equal(schedule(1), 250);
});

test("equal jitter keeps half the delay", () => {
	const schedule = constant(1000, { jitter: "equal", random: () => 0.5 });
	assert.equal(schedule(1), 750);
});

test("constant ignores the attempt number", () => {
	const schedule = constant(250, none);

	assert.deepEqual(
		[1, 5, 50].map((attempt) => schedule(attempt)),
		[250, 250, 250]
	);
});

test("fromList walks the list and then repeats its last delay", () => {
	const schedule = fromList([100, 500], none);

	assert.deepEqual(
		[1, 2, 3, 4].map((attempt) => schedule(attempt)),
		[100, 500, 500, 500]
	);
});

test("fromList refuses an empty list", () => {
	assert.throws(() => fromList([]), RangeError);
});
