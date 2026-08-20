import assert from "node:assert/strict";
import { test } from "node:test";

import {
	constant,
	fallback,
	retry,
	retryAnything,
	type FireflyEvent,
} from "../index.js";
import { VirtualClock } from "./virtual-clock.js";

test("passes a success through untouched", async () => {
	const answer = await fallback(() => "stale")(async () => "fresh")();
	assert.equal(answer, "fresh");
});

test("answers with the substitute when the work fails", async () => {
	const answer = await fallback(() => "stale")(async () => {
		throw new Error("upstream is down");
	})();

	assert.equal(answer, "stale");
});

test("the handler is given the failure it is answering for", async () => {
	const failure = new Error("upstream is down");
	const seen: unknown[] = [];

	await fallback((error) => {
		seen.push(error);
		return "stale";
	})(async () => {
		throw failure;
	})();

	assert.deepEqual(seen, [failure]);
});

test("a failure shouldFallback declines is rethrown unchanged", async () => {
	const failure = new TypeError("that is a bug, not an outage");

	await assert.rejects(
		fallback(() => "stale", {
			shouldFallback: (error) => !(error instanceof TypeError),
		})(async () => {
			throw failure;
		})(),
		(error) => error === failure
	);
});

test("the caller's abort is not answered for", async () => {
	const controller = new AbortController();
	controller.abort(new Error("caller gave up"));

	await assert.rejects(
		fallback(() => "stale")(async (signal) => {
			throw signal.reason;
		})(controller.signal),
		/caller gave up/
	);
});

test("wraps a whole stack, and sees the failure it ended with", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const policy = retry({
		attempts: 2,
		backoff: constant(100, { jitter: "none" }),
		shouldRetry: retryAnything,
		clock,
	});

	let calls = 0;
	const call = fallback(() => "stale", {
		onEvent: (event) => events.push(event),
	})(
		policy(async () => {
			calls++;
			throw new Error("upstream is down");
		})
	)();

	await clock.runAll();

	assert.equal(await call, "stale");
	assert.equal(calls, 2);
	assert.deepEqual(
		events.map((event) => event.type),
		["fallback"]
	);
});

test("an async handler is awaited", async () => {
	const answer = await fallback(async () => "stale")(async () => {
		throw new Error("down");
	})();

	assert.equal(answer, "stale");
});
