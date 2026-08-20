import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CircuitBreaker,
	constant,
	Dependency,
	hedge,
	retry,
	retryAnything,
	stack,
	timeout,
	type FireflyEvent,
} from "../index.js";
import { pendingAction, VirtualClock } from "./virtual-clock.js";

const backoff = constant(100, { jitter: "none" });

test("every event from one call carries the same id", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const onEvent = (event: FireflyEvent): void => {
		events.push(event);
	};

	const breaker = new CircuitBreaker({
		threshold: 10,
		resetAfter: 1_000,
		onEvent,
		clock,
	});

	const policy = stack(
		retry({
			attempts: 2,
			backoff,
			shouldRetry: retryAnything,
			onEvent,
			clock,
		}),
		breaker.policy,
		timeout(50, { onEvent, clock })
	);

	const call = policy(pendingAction())();
	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	const ids = new Set(events.map((event) => event.call));

	assert.ok(events.length >= 4);
	assert.equal(ids.size, 1);
	assert.deepEqual(
		events.map((event) => event.type),
		["attempt", "timeout", "retry", "attempt", "timeout"]
	);
});

test("separate calls are told apart", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];

	const policy = retry({
		attempts: 1,
		backoff,
		shouldRetry: retryAnything,
		onEvent: (event) => events.push(event),
		clock,
	});

	await policy(async () => "ok")();
	await policy(async () => "ok")();

	assert.equal(events.length, 2);
	assert.notEqual(events[0]?.call, events[1]?.call);
});

test("a hedged branch keeps the id of the call it belongs to", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const onEvent = (event: FireflyEvent): void => {
		events.push(event);
	};

	const policy = stack(
		hedge({ attempts: 2, delay: 100, onEvent, clock }),
		timeout(50, { onEvent, clock })
	);

	const call = policy(pendingAction())();
	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	assert.equal(new Set(events.map((event) => event.call)).size, 1);
});

test("a dependency reports every decision under one id per call", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];

	const dependency = new Dependency({
		name: "rates",
		attempts: 2,
		backoff,
		shouldRetry: retryAnything,
		deadline: 50,
		breaker: { threshold: 10, resetAfter: 1_000 },
		bulkhead: { concurrency: 1 },
		rateLimit: { capacity: 1, perSecond: 1 },
		clock,
		onEvent: (event) => events.push(event),
	});

	const call = dependency.run(pendingAction());
	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	assert.equal(new Set(events.map((event) => event.call)).size, 1);
});
