import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CircuitOpenError,
	constant,
	Dependency,
	exponential,
	retryAnything,
	TimeoutError,
	type FireflyEvent,
} from "../index.js";
import { pendingAction, VirtualClock } from "./virtual-clock.js";

const backoff = constant(1_000, { jitter: "none" });

function payments(clock: VirtualClock, events?: FireflyEvent[]): Dependency {
	return new Dependency({
		name: "payments",
		attempts: 3,
		backoff,
		shouldRetry: retryAnything,
		deadline: 2_000,
		breaker: { threshold: 2, resetAfter: 30_000 },
		bulkhead: { concurrency: 2, queue: 2 },
		rateLimit: { capacity: 10, perSecond: 5 },
		budget: { ratio: 0.2, capacity: 5 },
		clock,
		onEvent: events ? (event) => events.push(event) : undefined,
	});
}

test("runs the work and reports nothing wrong", async () => {
	const clock = new VirtualClock();
	const dependency = payments(clock);

	assert.equal(await dependency.run(async () => "ok"), "ok");
	assert.deepEqual(dependency.health(), {
		name: "payments",
		circuit: "closed",
		failures: 0,
		inFlight: 0,
		queued: 0,
		tokens: 9,
		retries: 5,
	});
});

test("retries, then reports the failure the work produced", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const failure = new Error("upstream is down");
	let calls = 0;

	// A breaker wide enough that all three attempts are made.
	const dependency = new Dependency({
		name: "payments",
		attempts: 3,
		backoff,
		shouldRetry: retryAnything,
		deadline: 2_000,
		breaker: { threshold: 10, resetAfter: 30_000 },
		clock,
		onEvent: (event) => events.push(event),
	});

	const call = dependency.run(async () => {
		calls++;
		throw failure;
	});

	const rejects = assert.rejects(call, (error) => error === failure);
	await clock.runAll();
	await rejects;

	assert.equal(calls, 3);
	assert.deepEqual(
		events.filter((event) => event.type === "retry").length,
		2
	);
});

test("the breaker sees every attempt, not one outage", async () => {
	const clock = new VirtualClock();
	const dependency = payments(clock);

	const call = dependency.run(async () => {
		throw new Error("upstream is down");
	});

	const rejects = assert.rejects(call, CircuitOpenError);
	await clock.runAll();
	await rejects;

	// Two attempts reached the threshold, so the third was refused.
	assert.equal(dependency.health().circuit, "open");
});

test("the deadline is per attempt", async () => {
	const clock = new VirtualClock();
	const dependency = new Dependency({
		name: "search",
		attempts: 2,
		backoff,
		shouldRetry: retryAnything,
		deadline: 500,
		breaker: false,
		clock,
	});

	const call = dependency.run(pendingAction());
	const rejects = assert.rejects(call, TimeoutError);
	await clock.runAll();
	await rejects;

	assert.equal(clock.now(), 2_000);
});

test("a dependency without a breaker says so rather than pretending", async () => {
	const clock = new VirtualClock();
	const dependency = new Dependency({
		name: "search",
		attempts: 1,
		backoff,
		shouldRetry: retryAnything,
		deadline: 500,
		breaker: false,
		clock,
	});

	assert.equal(dependency.breaker, undefined);
	assert.deepEqual(dependency.health(), {
		name: "search",
		circuit: "none",
		failures: 0,
		inFlight: 0,
		queued: 0,
	});
});

test("the state is the object's, so two call sites share it", async () => {
	const clock = new VirtualClock();
	const dependency = payments(clock);

	const first = dependency.wrap(pendingAction())();
	const second = dependency.wrap(pendingAction())();
	await clock.advance(0);

	assert.equal(dependency.health().inFlight, 2);

	const third = dependency.run(pendingAction());
	await clock.advance(0);

	assert.equal(dependency.health().queued, 1);

	const rejects = Promise.allSettled([first, second, third]);
	await clock.runAll();
	await rejects;
});

test("hedging is part of the description when you ask for it", async () => {
	const clock = new VirtualClock();
	let calls = 0;

	const dependency = new Dependency({
		name: "search",
		attempts: 1,
		backoff,
		shouldRetry: retryAnything,
		deadline: 10_000,
		breaker: false,
		hedge: { attempts: 2, delay: 100 },
		clock,
	});

	const call = dependency.run(async (signal) => {
		const index = calls++;
		await clock.sleep(index === 0 ? 5_000 : 10, signal);
		return index;
	});

	await clock.runAll();

	assert.equal(await call, 1);
	assert.equal(calls, 2);
});

test("callers sharing a key make one call, and share its attempts", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const dependency = new Dependency({
		name: "rates",
		attempts: 2,
		backoff,
		shouldRetry: retryAnything,
		deadline: 2_000,
		breaker: false,
		clock,
		onEvent: (event) => events.push(event),
	});

	let calls = 0;
	const read = async (): Promise<number> => {
		calls++;

		if (calls === 1) {
			throw new Error("upstream is down");
		}

		return calls;
	};

	const first = dependency.run(read, { share: "today" });
	const second = dependency.run(read, { share: "today" });
	await clock.runAll();

	assert.equal(await first, 2);
	assert.equal(await second, 2);

	// Two attempts of one call, rather than one attempt each.
	assert.equal(calls, 2);
	assert.equal(events.filter((event) => event.type === "retry").length, 1);
	assert.equal(dependency.shared.inFlight, 0);
});

test("a fallback answers once the call has failed all the way through", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const dependency = new Dependency({
		name: "rates",
		attempts: 2,
		backoff,
		shouldRetry: retryAnything,
		deadline: 2_000,
		breaker: false,
		clock,
		onEvent: (event) => events.push(event),
	});

	let calls = 0;
	const call = dependency.run(
		async () => {
			calls++;
			throw new Error("upstream is down");
		},
		{ fallback: () => "stale" }
	);

	await clock.runAll();

	assert.equal(await call, "stale");
	assert.equal(calls, 2);
	assert.equal(events.filter((event) => event.type === "fallback").length, 1);
});

test("a fallback that throws declines, and the failure stands", async () => {
	const clock = new VirtualClock();
	const dependency = new Dependency({
		name: "rates",
		attempts: 1,
		backoff,
		shouldRetry: retryAnything,
		deadline: 2_000,
		breaker: false,
		clock,
	});

	const failure = new TypeError("that is a bug, not an outage");

	await assert.rejects(
		dependency.run(
			async () => {
				throw failure;
			},
			{
				fallback: (error) => {
					throw error;
				},
			}
		),
		(error) => error === failure
	);
});

test("a fallback answers for a refusal as well as for a failure", async () => {
	const clock = new VirtualClock();
	const dependency = new Dependency({
		name: "rates",
		attempts: 1,
		backoff,
		shouldRetry: retryAnything,
		deadline: 2_000,
		breaker: { threshold: 1, resetAfter: 30_000 },
		clock,
	});

	await assert.rejects(
		dependency.run(async () => {
			throw new Error("upstream is down");
		})
	);
	assert.equal(dependency.health().circuit, "open");

	let refused: unknown;
	const answer = await dependency.run(async () => "fresh", {
		fallback: (error) => {
			refused = error;
			return "stale";
		},
	});

	assert.equal(answer, "stale");
	assert.ok(refused instanceof CircuitOpenError);
});

test("the numbers it was built from stay readable", () => {
	const clock = new VirtualClock();
	const dependency = new Dependency({
		name: "search",
		attempts: 4,
		backoff: exponential({ base: 100 }),
		shouldRetry: retryAnything,
		deadline: 1_500,
		breaker: false,
		clock,
	});

	assert.equal(dependency.options.attempts, 4);
	assert.equal(dependency.options.deadline, 1_500);
	assert.equal(dependency.name, "search");
});
