import assert from "node:assert/strict";
import { test } from "node:test";

import { RateLimitError, RateLimiter, type FireflyEvent } from "../index.js";
import { VirtualClock } from "./virtual-clock.js";

test("spends the burst without waiting", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 3, perSecond: 1, clock });

	for (let i = 0; i < 3; i++) {
		await limiter.take();
	}

	assert.equal(limiter.tokens, 0);
	assert.equal(clock.now(), 0);
});

test("waits exactly as long as the next token takes", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 1, perSecond: 2, clock });

	await limiter.take();
	const waiting = limiter.take();

	await clock.runAll();
	await waiting;

	assert.equal(clock.now(), 500);
});

test("refills against the clock rather than on a timer", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 10, perSecond: 5, clock });

	await limiter.take();
	assert.equal(limiter.tokens, 9);

	await clock.advance(1_000);
	assert.equal(limiter.tokens, 10);
	assert.equal(clock.pending, 0);
});

test("refuses rather than waits when told to", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const limiter = new RateLimiter({
		capacity: 1,
		perSecond: 1,
		onExhausted: "reject",
		clock,
		onEvent: (event) => events.push(event),
	});

	await limiter.take();

	await assert.rejects(limiter.take(), (error: unknown) => {
		assert.ok(error instanceof RateLimitError);
		assert.equal(error.retryAt, 1_000);
		return true;
	});

	assert.equal(events.length, 1);
	assert.deepEqual(
		events.map(({ call: _call, ...rest }) => rest),
		[{ type: "rate-limited", retryAt: 1_000, rejected: true }]
	);
});

test("the policy spends a token before the work runs", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 1, perSecond: 1, clock });
	const started: number[] = [];

	const work = async (): Promise<void> => {
		started.push(clock.now());
	};

	await limiter.policy(work)();
	const waiting = limiter.policy(work)();

	assert.deepEqual(started, [0]);

	await clock.runAll();
	await waiting;

	assert.deepEqual(started, [0, 1_000]);
});

test("a caller that aborts stops waiting for a token", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 1, perSecond: 1, clock });
	const controller = new AbortController();

	await limiter.take();
	const waiting = limiter.take(controller.signal);

	const rejects = assert.rejects(waiting, /caller gave up/);
	await clock.advance(100);
	controller.abort(new Error("caller gave up"));
	await rejects;
});

test("callers that wait are served in the order they arrived", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 1, perSecond: 1, clock });
	const served: string[] = [];

	await limiter.take();

	const first = limiter.take().then(() => served.push("first"));
	await clock.advance(0);
	const second = limiter.take().then(() => served.push("second"));
	await clock.advance(0);
	const third = limiter.take().then(() => served.push("third"));

	assert.equal(limiter.queued, 3);

	await clock.runAll();
	await Promise.all([first, second, third]);

	assert.deepEqual(served, ["first", "second", "third"]);
	assert.equal(clock.now(), 3_000);
});

test("a call arriving late cannot take the token someone is waiting for", async () => {
	const clock = new VirtualClock();
	const limiter = new RateLimiter({ capacity: 1, perSecond: 1, clock });
	const served: string[] = [];

	await limiter.take();

	const waiting = limiter.take().then(() => served.push("waiting"));
	await clock.advance(0);

	// Arrives when the bucket has refilled, but behind someone already queued.
	await clock.advance(1_000);
	const late = limiter.take().then(() => served.push("late"));

	await clock.runAll();
	await Promise.all([waiting, late]);

	assert.deepEqual(served, ["waiting", "late"]);
});
