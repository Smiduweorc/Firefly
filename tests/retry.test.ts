import assert from "node:assert/strict";
import { test } from "node:test";

import {
	constant,
	retry,
	retryAnything,
	RetryBudget,
	type FireflyEvent,
} from "../index.js";
import { VirtualClock } from "./virtual-clock.js";

const backoff = constant(1_000, { jitter: "none" });

test("returns the first success without waiting", async () => {
	const clock = new VirtualClock();
	const result = await retry({ attempts: 3, backoff, shouldRetry: retryAnything, clock })(async () => "ok")();

	assert.equal(result, "ok");
	assert.equal(clock.now(), 0);
});

test("rethrows the last failure unchanged once the attempts run out", async () => {
	const clock = new VirtualClock();
	const failure = new Error("still broken");
	let calls = 0;

	const call = retry({ attempts: 3, backoff, shouldRetry: retryAnything, clock })(async () => {
		calls++;
		throw failure;
	})();

	const rejects = assert.rejects(call, (error) => error === failure);
	await clock.runAll();
	await rejects;

	assert.equal(calls, 3);
	assert.equal(clock.now(), 2_000);
});

test("stops as soon as shouldRetry says so", async () => {
	const clock = new VirtualClock();
	let calls = 0;

	const call = retry({
		attempts: 5,
		backoff,
		shouldRetry: (_error, attempt) => attempt < 2,
		clock,
	})(async () => {
		calls++;
		throw new Error("nope");
	})();

	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	assert.equal(calls, 2);
});

test("does not start an attempt that would begin past maxElapsed", async () => {
	const clock = new VirtualClock();
	let calls = 0;

	const call = retry({
		attempts: 10,
		backoff,
		shouldRetry: retryAnything,
		maxElapsed: 2_500,
		clock,
	})(async () => {
		calls++;
		throw new Error("nope");
	})();

	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	assert.equal(calls, 3);
	assert.equal(clock.now(), 2_000);
});

test("an abort by the caller propagates instead of being retried", async () => {
	const clock = new VirtualClock();
	const controller = new AbortController();
	let calls = 0;

	const call = retry({ attempts: 5, backoff, shouldRetry: retryAnything, clock })(async (signal) => {
		calls++;
		controller.abort(new Error("caller gave up"));
		throw signal.reason;
	})(controller.signal);

	await assert.rejects(call, /caller gave up/);
	assert.equal(calls, 1);
});

test("an abort during the wait ends the loop", async () => {
	const clock = new VirtualClock();
	const controller = new AbortController();
	let calls = 0;

	const call = retry({ attempts: 5, backoff, shouldRetry: retryAnything, clock })(async () => {
		calls++;
		throw new Error("nope");
	})(controller.signal);

	const rejects = assert.rejects(call, /caller gave up/);
	await clock.advance(1);
	controller.abort(new Error("caller gave up"));
	await rejects;

	assert.equal(calls, 1);
});

test("reports every attempt and every wait", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];

	const call = retry({
		attempts: 2,
		backoff,
		shouldRetry: retryAnything,
		clock,
		onEvent: (event) => events.push(event),
	})(async () => {
		throw new Error("nope");
	})();

	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	assert.deepEqual(
		events.map((event) => event.type),
		["attempt", "retry", "attempt"]
	);
});

test("a throwing event sink does not fail the call", async () => {
	const clock = new VirtualClock();

	const result = await retry({
		attempts: 1,
		backoff,
		shouldRetry: retryAnything,
		clock,
		onEvent: () => {
			throw new Error("the metrics sink is down");
		},
	})(async () => "ok")();

	assert.equal(result, "ok");
});

test("a shared budget stops retries once it runs out", async () => {
	const clock = new VirtualClock();
	const budget = new RetryBudget({ ratio: 0.1, capacity: 2 });
	let calls = 0;

	const policy = retry({
		attempts: 5,
		backoff,
		shouldRetry: retryAnything,
		budget,
		clock,
	});

	const call = policy(async () => {
		calls++;
		throw new Error("nope");
	})();

	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	// One call earned 0.1, so the two it started with bought two retries.
	assert.equal(calls, 3);
	assert.ok(budget.tokens < 1);
});

test("the budget is earned back by the calls that do not retry", async () => {
	const budget = new RetryBudget({ ratio: 0.5, capacity: 4 });
	const clock = new VirtualClock();

	const policy = retry({
		attempts: 2,
		backoff,
		shouldRetry: retryAnything,
		budget,
		clock,
	});

	for (let i = 0; i < 4; i++) {
		await policy(async () => "ok")();
	}

	assert.equal(budget.tokens, 4);
});

test("running out of budget reports it and rethrows the failure", async () => {
	const clock = new VirtualClock();
	const budget = new RetryBudget({ ratio: 0, capacity: 0 });
	const events: FireflyEvent[] = [];
	const failure = new Error("nope");

	await assert.rejects(
		retry({
			attempts: 3,
			backoff,
			shouldRetry: retryAnything,
			budget,
			clock,
			onEvent: (event) => events.push(event),
		})(async () => {
			throw failure;
		})(),
		(error) => error === failure
	);

	assert.deepEqual(
		events.map((event) => event.type),
		["attempt", "budget-exhausted"]
	);
});
