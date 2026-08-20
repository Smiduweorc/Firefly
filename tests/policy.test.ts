import assert from "node:assert/strict";
import { test } from "node:test";

import {
	Bulkhead,
	CircuitBreaker,
	constant,
	hedge,
	kindOf,
	RateLimiter,
	retry,
	retryAnything,
	stack,
	tag,
	timeout,
	type Action,
	type Policy,
} from "../index.js";

function label(order: string[], name: string): Policy {
	return <T>(action: Action<T>) =>
		async (signal?: AbortSignal): Promise<T> => {
			order.push(`enter ${name}`);
			try {
				return await action(signal ?? new AbortController().signal);
			} finally {
				order.push(`leave ${name}`);
			}
		};
}

test("composes left to right, outermost first", async () => {
	const order: string[] = [];

	const policy = stack(
		label(order, "outer"),
		label(order, "middle"),
		label(order, "inner")
	);

	await policy(async () => {
		order.push("work");
		return 1;
	})();

	assert.deepEqual(order, [
		"enter outer",
		"enter middle",
		"enter inner",
		"work",
		"leave inner",
		"leave middle",
		"leave outer",
	]);
});

test("an empty stack still hands the action a signal", async () => {
	const seen = await stack()(async (signal) => signal.aborted)();
	assert.equal(seen, false);
});

test("the caller's signal reaches the action", async () => {
	const controller = new AbortController();
	const policy = stack(label([], "one"));

	const seen = await policy(async (signal) => signal)(controller.signal);
	assert.equal(seen, controller.signal);
});

test("refuses a stack whose order cannot work", () => {
	const breaker = new CircuitBreaker({ threshold: 1, resetAfter: 1 });
	const retrying = retry({
		attempts: 2,
		backoff: constant(0),
		shouldRetry: retryAnything,
	});

	assert.throws(() => stack(timeout(1), retrying), {
		name: "TypeError",
		message: /timeout was placed outside retry/,
	});

	assert.throws(() => stack(breaker.policy, retrying), {
		message: /circuit-breaker was placed outside retry/,
	});

	assert.throws(() => stack(new Bulkhead({ concurrency: 1 }).policy, breaker.policy), {
		message: /bulkhead was placed outside circuit-breaker/,
	});
});

test("accepts the order the package recommends", () => {
	const breaker = new CircuitBreaker({ threshold: 1, resetAfter: 1 });

	assert.doesNotThrow(() =>
		stack(
			retry({ attempts: 2, backoff: constant(0), shouldRetry: retryAnything }),
			hedge({ attempts: 2, delay: 10 }),
			breaker.policy,
			new RateLimiter({ capacity: 1, perSecond: 1 }).policy,
			new Bulkhead({ concurrency: 1 }).policy,
			timeout(1_000)
		)
	);
});

test("an unlabelled policy is passed through without an opinion", () => {
	const mine: Policy = <T>(action: Action<T>) => (signal?: AbortSignal) =>
		action(signal ?? new AbortController().signal);

	assert.equal(kindOf(mine), undefined);
	assert.doesNotThrow(() => stack(timeout(1), mine, timeout(2)));
});

test("labelling your own policy holds it to the same order", () => {
	const mine: Policy = <T>(action: Action<T>) => (signal?: AbortSignal) =>
		action(signal ?? new AbortController().signal);

	assert.equal(kindOf(tag(mine, "circuit-breaker")), "circuit-breaker");
	assert.throws(() => stack(mine, retry({
		attempts: 1,
		backoff: constant(0),
		shouldRetry: retryAnything,
	})), TypeError);
});

test("stack.unchecked composes the arrangement you meant", async () => {
	const order: string[] = [];
	const composed = stack.unchecked(
		timeout(1_000),
		label(order, "inner")
	);

	assert.equal(await composed(async () => "ok")(), "ok");
	assert.deepEqual(order, ["enter inner", "leave inner"]);
});
