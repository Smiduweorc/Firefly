import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CircuitBreaker,
	CircuitOpenError,
	TimeoutError,
	type FireflyEvent,
} from "../index.js";
import { deferred, VirtualClock } from "./virtual-clock.js";

function failing(error: unknown): () => Promise<never> {
	return async () => {
		throw error;
	};
}

test("opens on the threshold and refuses without calling the action", async () => {
	const clock = new VirtualClock();
	const cause = new Error("upstream is down");
	const breaker = new CircuitBreaker({ threshold: 2, resetAfter: 30_000, clock });
	let calls = 0;

	const call = breaker.policy(async () => {
		calls++;
		throw cause;
	});

	await assert.rejects(call(), (error) => error === cause);
	assert.equal(breaker.state, "closed");
	await assert.rejects(call(), (error) => error === cause);
	assert.equal(breaker.state, "open");

	await assert.rejects(call(), (error: unknown) => {
		assert.ok(error instanceof CircuitOpenError);
		assert.equal(error.cause, cause);
		assert.equal(error.openedAt, 0);
		assert.equal(error.retryAt, 30_000);
		return true;
	});

	assert.equal(calls, 2);
});

test("a success closes the circuit again after one trial call", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const breaker = new CircuitBreaker({
		threshold: 1,
		resetAfter: 1_000,
		clock,
		onEvent: (event) => events.push(event),
	});

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	assert.equal(breaker.state, "open");

	await clock.advance(1_000);
	assert.equal(breaker.state, "half-open");

	assert.equal(await breaker.policy(async () => "ok")(), "ok");
	assert.equal(breaker.state, "closed");

	assert.deepEqual(
		events.map((event) => event.type),
		["circuit-open", "circuit-half-open", "circuit-close"]
	);
});

test("a failed trial call opens the circuit for another window", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({ threshold: 1, resetAfter: 1_000, clock });

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	await clock.advance(1_000);
	await assert.rejects(breaker.policy(failing(new Error("still down")))());

	assert.equal(breaker.state, "open");
	await assert.rejects(breaker.policy(async () => "ok")(), CircuitOpenError);
});

test("only one call is let through while a trial is in flight", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({ threshold: 1, resetAfter: 1_000, clock });

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	await clock.advance(1_000);

	let release!: () => void;
	const trial = breaker.policy(
		() => new Promise<string>((resolve) => (release = () => resolve("ok")))
	)();

	await assert.rejects(breaker.policy(async () => "ok")(), CircuitOpenError);

	release();
	assert.equal(await trial, "ok");
	assert.equal(breaker.state, "closed");
});

test("an error isFailure declines is passed through without counting", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		threshold: 1,
		resetAfter: 1_000,
		isFailure: (error) => !(error instanceof TimeoutError),
		clock,
	});

	const ignored = new TimeoutError({ ms: 10, elapsed: 10 });
	await assert.rejects(breaker.policy(failing(ignored))(), (error) => error === ignored);

	assert.equal(breaker.state, "closed");
	assert.equal(breaker.failures, 0);
});

test("a success resets the count of consecutive failures", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({ threshold: 3, resetAfter: 1_000, clock });

	await assert.rejects(breaker.policy(failing(new Error("blip")))());
	await breaker.policy(async () => "ok")();
	await assert.rejects(breaker.policy(failing(new Error("blip")))());

	assert.equal(breaker.failures, 1);
	assert.equal(breaker.state, "closed");
});

test("a windowed breaker opens on the failure rate, not on a run", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		window: { size: 10, minimumCalls: 10, failureRate: 0.5 },
		resetAfter: 1_000,
		clock,
	});

	// Alternating, so a breaker counting consecutive failures never trips.
	for (let i = 0; i < 4; i++) {
		await breaker.policy(async () => "ok")();
		await assert.rejects(breaker.policy(failing(new Error("down")))());
	}

	assert.equal(breaker.state, "closed");
	assert.equal(breaker.failures, 4);

	await breaker.policy(async () => "ok")();
	await assert.rejects(breaker.policy(failing(new Error("down")))());

	assert.equal(breaker.state, "open");
});

test("a windowed breaker waits for the minimum before judging a rate", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		window: { size: 20, minimumCalls: 10, failureRate: 0.5 },
		resetAfter: 1_000,
		clock,
	});

	for (let i = 0; i < 9; i++) {
		await assert.rejects(breaker.policy(failing(new Error("down")))());
	}

	assert.equal(breaker.recorded, 9);
	assert.equal(breaker.state, "closed");

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	assert.equal(breaker.state, "open");
});

test("calls that are merely slow can open the circuit", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		window: {
			size: 10,
			minimumCalls: 4,
			failureRate: 1,
			slowerThan: 1_000,
			slowRate: 0.75,
		},
		resetAfter: 30_000,
		clock,
	});

	const slow = breaker.policy(async (signal) => {
		await clock.sleep(2_000, signal);
		return "eventually";
	});

	for (let i = 0; i < 4; i++) {
		const call = slow();
		await clock.runAll();
		assert.equal(await call, "eventually");
	}

	assert.equal(breaker.state, "open");
	assert.equal(breaker.failures, 0);
});

test("closing after a trial forgets the window that opened it", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		window: { size: 4, minimumCalls: 2, failureRate: 0.5 },
		resetAfter: 1_000,
		clock,
	});

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	await assert.rejects(breaker.policy(failing(new Error("down")))());
	assert.equal(breaker.state, "open");

	await clock.advance(1_000);
	await breaker.policy(async () => "ok")();

	assert.equal(breaker.state, "closed");
	assert.equal(breaker.recorded, 0);
});

test("a time-based window forgets what happened long enough ago", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		window: { size: 100, within: 10_000, minimumCalls: 4, failureRate: 0.5 },
		resetAfter: 1_000,
		clock,
	});

	for (let i = 0; i < 3; i++) {
		await assert.rejects(breaker.policy(failing(new Error("down")))());
	}

	assert.equal(breaker.recorded, 3);

	// Long enough later that this morning's failures are not evidence.
	await clock.advance(10_001);
	assert.equal(breaker.recorded, 0);

	for (let i = 0; i < 3; i++) {
		await assert.rejects(breaker.policy(failing(new Error("down")))());
	}

	assert.equal(breaker.state, "closed");

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	assert.equal(breaker.state, "open");
});

test("several probes are allowed through, and all must pass to close it", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		threshold: 1,
		resetAfter: 1_000,
		probes: 3,
		clock,
	});

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	await clock.advance(1_000);

	const held = deferred<string>();
	const probes = [
		breaker.policy(async () => held.promise)(),
		breaker.policy(async () => held.promise)(),
		breaker.policy(async () => held.promise)(),
	];

	// A fourth is refused: three is what was asked for.
	await assert.rejects(breaker.policy(async () => "ok")(), CircuitOpenError);

	held.resolve("ok");
	await Promise.all(probes);

	assert.equal(breaker.state, "closed");
});

test("one failed probe reopens the circuit and the rest cannot close it", async () => {
	const clock = new VirtualClock();
	const breaker = new CircuitBreaker({
		threshold: 1,
		resetAfter: 1_000,
		probes: 2,
		clock,
	});

	await assert.rejects(breaker.policy(failing(new Error("down")))());
	await clock.advance(1_000);

	const slow = deferred<string>();
	const lingering = breaker.policy(async () => slow.promise)();
	await assert.rejects(breaker.policy(failing(new Error("still down")))());

	assert.equal(breaker.state, "open");

	// The probe that was still in flight belongs to the outage before last.
	slow.resolve("ok");
	await lingering;

	assert.equal(breaker.state, "open");
	assert.equal(breaker.failures, 0);
});
