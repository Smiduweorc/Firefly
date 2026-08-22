import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import {
	constant,
	FireflyError,
	retry,
	retryAnything,
	stack,
	TimeoutError,
	timeout,
} from "../index.js";
import { deferred, pendingAction, VirtualClock } from "./virtual-clock.js";

test("passes a result through untouched and cancels its timer", async () => {
	const clock = new VirtualClock();

	assert.equal(await timeout(1_000, { clock })(async () => 42)(), 42);
	assert.equal(clock.pending, 0);
});

test("rejects with a TimeoutError carrying the deadline and the elapsed time", async () => {
	const clock = new VirtualClock();
	const call = timeout(2_000, { clock })(pendingAction())();

	const rejects = assert.rejects(call, (error: unknown) => {
		assert.ok(error instanceof TimeoutError);
		assert.ok(error instanceof FireflyError);
		assert.equal(error.ms, 2_000);
		assert.equal(error.elapsed, 2_000);
		return true;
	});

	await clock.advance(2_000);
	await rejects;
});

test("aborts the attempt's own signal with the timeout as the reason", async () => {
	const clock = new VirtualClock();
	let reason: unknown;

	const call = timeout(1_000, { clock })(async (signal) => {
		signal.addEventListener("abort", () => {
			reason = signal.reason;
		});
		return pendingAction()(signal);
	})();

	const rejects = assert.rejects(call, TimeoutError);
	await clock.advance(1_000);
	await rejects;

	assert.ok(reason instanceof TimeoutError);
});

test("the caller's signal aborts the attempt as well", async () => {
	const clock = new VirtualClock();
	const controller = new AbortController();
	const call = timeout(10_000, { clock })(pendingAction())(controller.signal);

	const rejects = assert.rejects(call, /caller gave up/);
	controller.abort(new Error("caller gave up"));
	await rejects;
});

test("an action that ignores its signal still rejects on time", async () => {
	const clock = new VirtualClock();
	const work = deferred<string>();
	const call = timeout(500, { clock })(async () => work.promise)();

	const rejects = assert.rejects(call, TimeoutError);
	await clock.advance(500);
	await rejects;

	work.resolve("too late");
});

test("reports the deadline it reached", async () => {
	const clock = new VirtualClock();
	const events: string[] = [];
	const call = timeout(300, {
		clock,
		onEvent: (event) => events.push(event.type),
	})(pendingAction())();

	const rejects = assert.rejects(call, TimeoutError);
	await clock.advance(300);
	await rejects;

	assert.deepEqual(events, ["timeout"]);
});

test("an attempt never outlives the operation's budget", async () => {
	const clock = new VirtualClock();
	const policy = stack(
		retry({
			attempts: 5,
			backoff: constant(0),
			shouldRetry: retryAnything,
			maxElapsed: 2_500,
			clock,
		}),
		timeout(2_000, { clock })
	);

	const call = policy(pendingAction())();
	const rejects = assert.rejects(call, TimeoutError);
	await clock.runAll();
	await rejects;

	// Two attempts: 2s, then 500ms of budget rather than another 2s.
	assert.equal(clock.now(), 2_500);
});

test("a deadline shorter than the remaining budget is left alone", async () => {
	const clock = new VirtualClock();
	const policy = stack(
		retry({
			attempts: 1,
			backoff: constant(0),
			shouldRetry: retryAnything,
			maxElapsed: 60_000,
			clock,
		}),
		timeout(500, { clock })
	);

	const call = policy(pendingAction())();
	const rejects = assert.rejects(call, TimeoutError);
	await clock.runAll();
	await rejects;

	assert.equal(clock.now(), 500);
});

test("detaches from the caller's signal once the call has settled", async () => {
	const clock = new VirtualClock();
	const caller = new AbortController();
	const wrapped = timeout(1_000, { clock })(async () => 42);

	for (let call = 0; call < 10; call++) {
		assert.equal(await wrapped(caller.signal), 42);
	}

	// A signal handed to every call — a shutdown signal, say — must not collect
	// a listener per call.
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
