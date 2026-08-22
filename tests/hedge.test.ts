import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import {
	constant,
	Dependency,
	hedge,
	HedgeAbandonedError,
	retryAnything,
	RetryBudget,
	stack,
	timeout,
	TimeoutError,
	type Action,
	type FireflyEvent,
} from "../index.js";
import { VirtualClock } from "./virtual-clock.js";

/** An action that answers after `ms` on the virtual clock, or when its signal aborts. */
function answersIn(
	clock: VirtualClock,
	ms: number[],
	value = "answer"
): { action: Action<string>; signals: AbortSignal[] } {
	const signals: AbortSignal[] = [];

	const action: Action<string> = async (signal) => {
		const index = signals.length;
		signals.push(signal);
		await clock.sleep(ms[Math.min(index, ms.length - 1)] ?? 0, signal);
		return `${value} ${index + 1}`;
	};

	return { action, signals };
}

test("takes the first attempt when it answers before the delay", async () => {
	const clock = new VirtualClock();
	const { action, signals } = answersIn(clock, [50]);

	const call = hedge({ attempts: 3, delay: 100, clock })(action)();
	await clock.runAll();

	assert.equal(await call, "answer 1");
	assert.equal(signals.length, 1);
	assert.equal(clock.now(), 50);
});

test("starts another attempt once the delay passes and takes the first answer", async () => {
	const clock = new VirtualClock();
	const { action, signals } = answersIn(clock, [1_000, 10]);

	const call = hedge({ attempts: 2, delay: 100, clock })(action)();
	await clock.runAll();

	assert.equal(await call, "answer 2");
	assert.equal(signals.length, 2);
	assert.equal(clock.now(), 110);
});

test("the attempts it abandons are aborted, and the one it keeps is not", async () => {
	const clock = new VirtualClock();
	const { action, signals } = answersIn(clock, [1_000, 10]);

	const call = hedge({ attempts: 2, delay: 100, clock })(action)();
	await clock.runAll();
	await call;

	const [first, second] = signals as [AbortSignal, AbortSignal];

	assert.equal(first.aborted, true);
	assert.ok(first.reason instanceof HedgeAbandonedError);
	assert.equal(first.reason.attempt, 1);
	assert.equal(second.aborted, false);
});

test("spaces the attempts with a schedule when given one", async () => {
	const clock = new VirtualClock();
	const { action, signals } = answersIn(clock, [10_000, 10_000, 5]);

	const call = hedge({
		attempts: 3,
		delay: constant(100, { jitter: "none" }),
		clock,
	})(action)();

	await clock.runAll();
	await call;

	assert.equal(signals.length, 3);
	assert.equal(clock.now(), 205);
});

test("reports each attempt beyond the first", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const { action } = answersIn(clock, [1_000, 1_000, 1]);

	const call = hedge({
		attempts: 3,
		delay: 100,
		clock,
		onEvent: (event) => events.push(event),
	})(action)();

	await clock.runAll();
	await call;

	assert.deepEqual(
		events.map(({ call, ...rest }) => ({ ...rest, sameCall: call === events[0]?.call })),
		[
			{ type: "hedge", attempt: 2, sameCall: true },
			{ type: "hedge", attempt: 3, sameCall: true },
		]
	);
});

test("a failure is passed straight through when no shouldHedge is given", async () => {
	const clock = new VirtualClock();
	const failure = new Error("nope");
	let calls = 0;

	const call = hedge({ attempts: 3, delay: 100, clock })(async () => {
		calls++;
		throw failure;
	})();

	const rejects = assert.rejects(call, (error) => error === failure);
	await clock.runAll();
	await rejects;

	assert.equal(calls, 1);
});

test("shouldHedge starts the next attempt without waiting out the delay", async () => {
	const clock = new VirtualClock();
	let calls = 0;

	const call = hedge({
		attempts: 3,
		delay: 10_000,
		shouldHedge: () => true,
		clock,
	})(async () => {
		calls++;
		if (calls < 3) {
			throw new Error("nope");
		}
		return "third time";
	})();

	await clock.runAll();

	assert.equal(await call, "third time");
	assert.equal(calls, 3);
	assert.equal(clock.now(), 0);
});

test("every attempt failing rethrows the last failure unchanged", async () => {
	const clock = new VirtualClock();
	const failures = [new Error("one"), new Error("two")];
	let calls = 0;

	const call = hedge({
		attempts: 2,
		delay: 10,
		shouldHedge: () => true,
		clock,
	})(async () => {
		throw failures[calls++];
	})();

	const rejects = assert.rejects(call, (error) => error === failures[1]);
	await clock.runAll();
	await rejects;
});

test("the caller's abort ends every attempt", async () => {
	const clock = new VirtualClock();
	const controller = new AbortController();
	const { action, signals } = answersIn(clock, [10_000]);

	const call = hedge({ attempts: 2, delay: 100, clock })(action)(
		controller.signal
	);

	const rejects = assert.rejects(call, /caller gave up/);
	await clock.advance(150);
	controller.abort(new Error("caller gave up"));
	await rejects;

	assert.equal(signals.length, 2);
	assert.ok(signals.every((signal) => signal.aborted));
});

test("a deadline inside the hedge applies to each attempt on its own", async () => {
	const clock = new VirtualClock();
	const { action } = answersIn(clock, [10_000, 10_000]);

	const call = stack(
		hedge({ attempts: 2, delay: 100, clock }),
		timeout(500, { clock })
	)(action)();

	const rejects = assert.rejects(call, TimeoutError);
	await clock.runAll();
	await rejects;
});

test("a budget stops the hedge from doubling load it cannot afford", async () => {
	const clock = new VirtualClock();
	const budget = new RetryBudget({ ratio: 0.1, capacity: 1 });
	const events: FireflyEvent[] = [];
	const { action, signals } = answersIn(clock, [10_000, 10_000, 10_000, 5]);

	const call = hedge({
		attempts: 4,
		delay: 100,
		budget,
		clock,
		onEvent: (event) => events.push(event),
	})(action)();

	await clock.advance(1_000);

	// One token bought one extra attempt; the rest were refused.
	assert.equal(signals.length, 2);
	assert.deepEqual(
		events.map((event) => event.type),
		["hedge", "budget-exhausted"]
	);

	// The two that did start still race each other to the end.
	await clock.runAll();
	assert.equal(await call, "answer 1");
});

test("a dependency shares one budget between its retries and its hedges", async () => {
	const clock = new VirtualClock();
	const dependency = new Dependency({
		name: "search",
		attempts: 3,
		backoff: constant(10, { jitter: "none" }),
		shouldRetry: retryAnything,
		deadline: 10_000,
		breaker: false,
		hedge: { attempts: 3, delay: 50 },
		budget: { ratio: 0.1, capacity: 2 },
		clock,
	});

	let calls = 0;
	const call = dependency.run(async (signal) => {
		calls++;
		await clock.sleep(5_000, signal);
		throw new Error("too slow");
	});

	const rejects = assert.rejects(call);
	await clock.runAll();
	await rejects;

	// Two tokens: one hedged branch and one retry, not four of each.
	assert.equal(calls, 3);
});

test("detaches every branch from the caller's signal once the call has settled", async () => {
	const clock = new VirtualClock();
	const caller = new AbortController();

	for (let call = 0; call < 10; call++) {
		const { action } = answersIn(clock, [50, 10]);
		const running = hedge({ attempts: 3, delay: 20, clock })(action)(caller.signal);

		await clock.runAll();
		assert.equal(await running, "answer 2");
	}

	// The winner is left alone but detached: the caller's signal collects
	// nothing across calls, hedged or not.
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
