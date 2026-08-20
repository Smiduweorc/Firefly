import assert from "node:assert/strict";
import { test } from "node:test";

import { Bulkhead, BulkheadFullError, type FireflyEvent } from "../index.js";
import { deferred, VirtualClock } from "./virtual-clock.js";

test("runs up to the concurrency limit and queues the rest", async () => {
	const bulkhead = new Bulkhead({ concurrency: 1, queue: 1 });
	const first = deferred<string>();
	const second = deferred<string>();

	const running = bulkhead.policy(async () => first.promise)();
	const queued = bulkhead.policy(async () => second.promise)();

	assert.equal(bulkhead.inFlight, 1);
	assert.equal(bulkhead.queued, 1);

	first.resolve("first");
	assert.equal(await running, "first");

	second.resolve("second");
	assert.equal(await queued, "second");
	assert.equal(bulkhead.inFlight, 0);
});

test("refuses once the queue is full as well", async () => {
	const events: FireflyEvent[] = [];
	const bulkhead = new Bulkhead({
		concurrency: 1,
		queue: 1,
		onEvent: (event) => events.push(event),
	});

	const work = deferred<string>();
	const running = bulkhead.policy(async () => work.promise)();
	const queued = bulkhead.policy(async () => work.promise)();

	await assert.rejects(
		bulkhead.policy(async () => "third")(),
		(error: unknown) => {
			assert.ok(error instanceof BulkheadFullError);
			assert.equal(error.concurrency, 1);
			assert.equal(error.queued, 1);
			return true;
		}
	);

	work.resolve("done");
	await Promise.all([running, queued]);

	assert.deepEqual(
		events.map((event) => event.type),
		["bulkhead-queued", "bulkhead-rejected"]
	);
});

test("refuses instead of queueing when no queue is configured", async () => {
	const bulkhead = new Bulkhead({ concurrency: 1 });
	const work = deferred<string>();
	const running = bulkhead.policy(async () => work.promise)();

	await assert.rejects(bulkhead.policy(async () => "second")(), BulkheadFullError);

	work.resolve("done");
	await running;
});

test("a slot is released when the work fails", async () => {
	const bulkhead = new Bulkhead({ concurrency: 1 });

	await assert.rejects(
		bulkhead.policy(async () => {
			throw new Error("nope");
		})()
	);

	assert.equal(bulkhead.inFlight, 0);
	assert.equal(await bulkhead.policy(async () => "ok")(), "ok");
});

test("a queued call gives up when its caller aborts", async () => {
	const bulkhead = new Bulkhead({ concurrency: 1, queue: 5 });
	const controller = new AbortController();
	const work = deferred<string>();

	const running = bulkhead.policy(async () => work.promise)();
	let started = false;
	const queued = bulkhead.policy(async () => {
		started = true;
		return "queued";
	})(controller.signal);

	const rejects = assert.rejects(queued, /caller gave up/);
	controller.abort(new Error("caller gave up"));
	await rejects;

	assert.equal(bulkhead.queued, 0);
	work.resolve("done");
	await running;

	assert.equal(started, false);
	assert.equal(bulkhead.inFlight, 0);
});

test("the slot goes to the call that has waited longest", async () => {
	const bulkhead = new Bulkhead({ concurrency: 1, queue: 3 });
	const order: string[] = [];
	const work = deferred<string>();

	const running = bulkhead.policy(async () => work.promise)();
	const second = bulkhead.policy(async () => {
		order.push("second");
		return "second";
	})();
	const third = bulkhead.policy(async () => {
		order.push("third");
		return "third";
	})();

	work.resolve("first");
	await Promise.all([running, second, third]);

	assert.deepEqual(order, ["second", "third"]);
});

test("a call waiting too long for a slot is refused rather than left there", async () => {
	const clock = new VirtualClock();
	const bulkhead = new Bulkhead({
		concurrency: 1,
		queue: 5,
		queueTimeout: 250,
		clock,
	});

	const work = deferred<string>();
	const running = bulkhead.policy(async () => work.promise)();
	await clock.advance(0);

	let started = false;
	const queued = bulkhead.policy(async () => {
		started = true;
		return "queued";
	})();

	const rejects = assert.rejects(queued, BulkheadFullError);
	await clock.advance(250);
	await rejects;

	assert.equal(started, false);
	assert.equal(bulkhead.queued, 0);

	work.resolve("done");
	await running;
});

test("a slot that comes free in time is taken normally", async () => {
	const clock = new VirtualClock();
	const bulkhead = new Bulkhead({
		concurrency: 1,
		queue: 5,
		queueTimeout: 10_000,
		clock,
	});

	const work = deferred<string>();
	const running = bulkhead.policy(async () => work.promise)();
	await clock.advance(0);

	const queued = bulkhead.policy(async () => "queued")();
	await clock.advance(100);

	work.resolve("done");

	assert.equal(await running, "done");
	assert.equal(await queued, "queued");
	assert.equal(clock.pending, 0);
});

test("the limit shrinks on failures and grows again under pressure", async () => {
	const clock = new VirtualClock();
	const bulkhead = new Bulkhead({
		concurrency: 10,
		queue: 100,
		adapt: { min: 2, max: 10 },
		clock,
	});

	for (let i = 0; i < 20; i++) {
		await assert.rejects(
			bulkhead.policy(async () => {
				throw new Error("upstream is down");
			})()
		);
	}

	assert.equal(bulkhead.concurrency, 2);

	// Recovering: successes only widen the bulkhead while it is the limit.
	for (let i = 0; i < 40; i++) {
		const held = deferred<string>();
		const first = bulkhead.policy(async () => held.promise)();
		const second = bulkhead.policy(async () => held.promise)();
		held.resolve("ok");
		await Promise.all([first, second]);
	}

	assert.ok(bulkhead.concurrency > 2);
});

test("a slow call counts against the limit even when it succeeds", async () => {
	const clock = new VirtualClock();
	const bulkhead = new Bulkhead({
		concurrency: 8,
		adapt: { min: 1, max: 8, slowerThan: 1_000 },
		clock,
	});

	for (let i = 0; i < 10; i++) {
		const call = bulkhead.policy(async (signal) => {
			await clock.sleep(2_000, signal);
			return "eventually";
		})();

		await clock.runAll();
		await call;
	}

	assert.ok(bulkhead.concurrency < 8);
});
