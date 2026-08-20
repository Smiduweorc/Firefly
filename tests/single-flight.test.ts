import assert from "node:assert/strict";
import { test } from "node:test";

import { SingleFlight } from "../index.js";
import { deferred, pendingAction } from "./virtual-clock.js";

test("concurrent callers on one key share the call", async () => {
	const flight = new SingleFlight();
	const work = deferred<string>();
	let calls = 0;

	const action = async (): Promise<string> => {
		calls++;
		return work.promise;
	};

	const first = flight.run("rates", action);
	const second = flight.run("rates", action);

	assert.equal(flight.inFlight, 1);

	work.resolve("shared");
	assert.deepEqual(await Promise.all([first, second]), ["shared", "shared"]);
	assert.equal(calls, 1);
});

test("different keys do not share anything", async () => {
	const flight = new SingleFlight();
	let calls = 0;

	await Promise.all([
		flight.run("one", async () => calls++),
		flight.run("two", async () => calls++),
	]);

	assert.equal(calls, 2);
});

test("nothing is kept once the call settles", async () => {
	const flight = new SingleFlight();
	let calls = 0;
	const action = async (): Promise<number> => ++calls;

	assert.equal(await flight.run("rates", action), 1);
	assert.equal(flight.has("rates"), false);
	assert.equal(await flight.run("rates", action), 2);
});

test("a failure reaches every caller and is not remembered", async () => {
	const flight = new SingleFlight();
	const failure = new Error("upstream is down");
	const work = deferred<never>();

	const first = flight.run("rates", async () => work.promise);
	const second = flight.run("rates", async () => work.promise);

	work.reject(failure);

	await assert.rejects(first, (error) => error === failure);
	await assert.rejects(second, (error) => error === failure);
	assert.equal(flight.inFlight, 0);
});

test("one caller leaving does not abandon the others", async () => {
	const flight = new SingleFlight();
	const controller = new AbortController();
	const work = deferred<string>();
	let aborted = false;

	const action = async (signal: AbortSignal): Promise<string> => {
		signal.addEventListener("abort", () => {
			aborted = true;
		});
		return work.promise;
	};

	const leaving = flight.run("rates", action, controller.signal);
	const staying = flight.run("rates", action);

	const rejects = assert.rejects(leaving, /gone/);
	controller.abort(new Error("gone"));
	await rejects;

	assert.equal(aborted, false);

	work.resolve("shared");
	assert.equal(await staying, "shared");
});

test("the last caller to leave aborts the work", async () => {
	const flight = new SingleFlight();
	const controller = new AbortController();
	const call = flight.run("rates", pendingAction(), controller.signal);

	const rejects = assert.rejects(call, /everyone left/);
	controller.abort(new Error("everyone left"));
	await rejects;

	assert.equal(flight.inFlight, 0);
});

test("the policy collapses everything it wraps under one key", async () => {
	const flight = new SingleFlight();
	const work = deferred<string>();
	let calls = 0;

	const policy = flight.policy("rates");
	const action = async (): Promise<string> => {
		calls++;
		return work.promise;
	};

	const first = policy(action)();
	const second = policy(action)();

	work.resolve("shared");
	await Promise.all([first, second]);

	assert.equal(calls, 1);
});
