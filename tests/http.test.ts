import assert from "node:assert/strict";
import { test } from "node:test";

import {
	BulkheadFullError,
	CircuitOpenError,
	constant,
	hedge,
	retry,
	stack,
	timeout,
	TimeoutError,
	type FireflyEvent,
} from "../index.js";
import {
	byRequest,
	parseRetryAfter,
	RetryableResponseError,
	retryableApiError,
	retryableTransportError,
	transport,
	type Transport,
} from "../http.js";
import { VirtualClock } from "./virtual-clock.js";

const backoff = constant(1_000, { jitter: "none" });

/** Answers with each response in turn, repeating the last, minting a fresh one per call as `fetch` does. */
function replies(...responses: (() => Response)[]): {
	send: Transport;
	sent: Request[];
} {
	const sent: Request[] = [];
	let index = 0;

	return {
		sent,
		send: async (request) => {
			sent.push(request);
			const next = responses[Math.min(index++, responses.length - 1)];
			return next ? next() : new Response(null, { status: 500 });
		},
	};
}

test("a response the policy does not retry comes back untouched", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(() => new Response("body", { status: 404 }));
	const send404 = transport(send, retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }), {
		clock,
	});

	const response = await send404(new Request("https://api.test/things"));

	assert.equal(response.status, 404);
	assert.equal(response.bodyUsed, false);
	assert.equal(await response.text(), "body");
	assert.equal(sent.length, 1);
});

test("a retryable status is retried and the last response is returned whole", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(() => new Response("busy", { status: 503 }));
	const call = transport(send, retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }), { clock })(
		new Request("https://api.test/things")
	);

	await clock.runAll();
	const response = await call;

	assert.equal(sent.length, 3);
	assert.equal(response.status, 503);
	assert.equal(await response.text(), "busy");
	assert.equal(clock.now(), 2_000);
});

test("a response that is discarded has its body cancelled", async () => {
	const clock = new VirtualClock();
	const busy = new Response("busy", { status: 503 });
	const { send } = replies(() => busy, () => new Response("ok"));
	const call = transport(send, retry({ attempts: 2, backoff, shouldRetry: retryableTransportError, clock }), { clock })(
		new Request("https://api.test/things")
	);

	await clock.runAll();
	const response = await call;

	assert.equal(await response.text(), "ok");
	assert.equal(busy.bodyUsed, true);
});

test("Retry-After in seconds is absorbed into the wait before the next attempt", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(
		() => new Response(null, { status: 429, headers: { "retry-after": "2" } }),
		() => new Response("ok")
	);

	const call = transport(send, retry({ attempts: 2, backoff, shouldRetry: retryableTransportError, clock }), { clock })(
		new Request("https://api.test/things")
	);

	await clock.runAll();
	await call;

	assert.equal(sent.length, 2);
	assert.equal(clock.now(), 2_000);
});

test("Retry-After as an HTTP-date is honoured too", async () => {
	const clock = new VirtualClock();
	const when = new Date(clock.now() + 4_000).toUTCString();
	const { send } = replies(
		() => new Response(null, { status: 503, headers: { "retry-after": when } }),
		() => new Response("ok")
	);

	const call = transport(send, retry({ attempts: 2, backoff, shouldRetry: retryableTransportError, clock }), { clock })(
		new Request("https://api.test/things")
	);

	await clock.runAll();
	await call;

	assert.ok(clock.now() >= 4_000);
});

test("a Retry-After longer than the ceiling is clamped to it", async () => {
	const clock = new VirtualClock();
	const { send } = replies(
		() => new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
		() => new Response("ok")
	);

	const call = transport(send, retry({ attempts: 2, backoff, shouldRetry: retryableTransportError, clock }), {
		clock,
		maxRetryAfter: 5_000,
	})(new Request("https://api.test/things"));

	await clock.runAll();
	await call;

	assert.equal(clock.now(), 5_000);
});

test("every attempt is sent with a body of its own", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(() => new Response(null, { status: 500 }));

	const call = transport(send, retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }), { clock })(
		new Request("https://api.test/things", {
			method: "PUT",
			body: JSON.stringify({ id: 1 }),
		})
	);

	await clock.runAll();
	await call;

	const body = JSON.stringify({ id: 1 });

	assert.equal(sent.length, 3);
	assert.deepEqual(await Promise.all(sent.map((request) => request.text())), [
		body,
		body,
		body,
	]);
});

test("a POST is sent once, however many attempts the policy has", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(() => new Response("busy", { status: 503 }));

	const response = await transport(
		send,
		retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }),
		{ clock }
	)(new Request("https://api.test/things", { method: "POST", body: "{}" }));

	assert.equal(sent.length, 1);
	assert.equal(response.status, 503);
	assert.equal(clock.now(), 0);
});

test("a POST carrying an Idempotency-Key is retried", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(
		() => new Response(null, { status: 503 }),
		() => new Response("ok")
	);

	const call = transport(send, retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }), { clock })(
		new Request("https://api.test/things", {
			method: "POST",
			body: "{}",
			headers: { "idempotency-key": "8f1b" },
		})
	);

	await clock.runAll();
	assert.equal((await call).status, 200);
	assert.equal(sent.length, 2);
});

test("retryUnsafeMethods answers the question the transport cannot", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(
		() => new Response(null, { status: 503 }),
		() => new Response("ok")
	);

	const call = transport(send, retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }), {
		clock,
		retryUnsafeMethods: true,
	})(new Request("https://api.test/things", { method: "PATCH", body: "{}" }));

	await clock.runAll();
	await call;

	assert.equal(sent.length, 2);
});

test("a request that cannot be replayed is not sent again after a rejection", async () => {
	const clock = new VirtualClock();
	const failure = new Error("connection reset");
	let calls = 0;

	const call = transport(
		async () => {
			calls++;
			throw failure;
		},
		retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }),
		{ clock }
	)(new Request("https://api.test/things", { method: "POST", body: "{}" }));

	const rejects = assert.rejects(call, (error) => error === failure);
	await clock.runAll();
	await rejects;

	assert.equal(calls, 1);
});

test("the caller's abort is not retried", async () => {
	const clock = new VirtualClock();
	const controller = new AbortController();
	let calls = 0;

	const call = transport(
		(request) =>
			new Promise<Response>((_, reject) => {
				calls++;
				request.signal.addEventListener("abort", () =>
					reject(request.signal.reason)
				);
			}),
		retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock }),
		{ clock }
	)(new Request("https://api.test/things", { signal: controller.signal }));

	const rejects = assert.rejects(call, /caller gave up/);
	controller.abort(new Error("caller gave up"));
	await rejects;

	assert.equal(calls, 1);
});

test("a deadline aborts the request that is in flight", async () => {
	const clock = new VirtualClock();
	let aborted: unknown;

	const call = transport(
		(request) =>
			new Promise<Response>((_, reject) => {
				request.signal.addEventListener("abort", () => {
					aborted = request.signal.reason;
					reject(request.signal.reason);
				});
			}),
		stack(retry({ attempts: 1, backoff, shouldRetry: retryableTransportError, clock }), timeout(2_000, { clock })),
		{ clock }
	)(new Request("https://api.test/things"));

	const rejects = assert.rejects(call, TimeoutError);
	await clock.advance(2_000);
	await rejects;

	assert.ok(aborted instanceof TimeoutError);
});

test("a policy in between sees the retryable response as a failure", async () => {
	const clock = new VirtualClock();
	const { send } = replies(() => new Response(null, { status: 502 }));
	const seen: unknown[] = [];

	const call = transport(
		send,
		retry({
			attempts: 2,
			backoff,
			clock,
			shouldRetry: (error) => {
				seen.push(error);
				return true;
			},
		}),
		{ clock }
	)(new Request("https://api.test/things"));

	await clock.runAll();
	await call;

	assert.equal(seen.length, 1);
	assert.ok(seen[0] instanceof RetryableResponseError);
	assert.equal((seen[0] as RetryableResponseError).status, 502);
});

test("byRequest picks the policy for each request", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(() => new Response(null, { status: 500 }));

	const send500 = transport(
		send,
		byRequest((request) =>
			request.url.includes("/payments")
				? retry({ attempts: 1, backoff, shouldRetry: retryableTransportError, clock })
				: retry({ attempts: 3, backoff, shouldRetry: retryableTransportError, clock })
		),
		{ clock }
	);

	await send500(new Request("https://api.test/payments/1"));
	assert.equal(sent.length, 1);

	const call = send500(new Request("https://api.test/search"));
	await clock.runAll();
	await call;

	assert.equal(sent.length, 4);
});

test("retryableApiError recognises the templates' errors by shape", () => {
	class TransportError extends Error {
		override readonly name = "TransportError";
	}
	class HttpError extends Error {
		override readonly name = "HttpError";
		readonly status: number;
		constructor(status: number) {
			super(`HTTP ${status}`);
			this.status = status;
		}
	}
	class DecodeError extends Error {
		override readonly name = "DecodeError";
	}

	assert.equal(retryableApiError(new TransportError("reset")), true);
	assert.equal(
		retryableApiError(
			new TransportError("aborted", {
				cause: new DOMException("aborted", "AbortError"),
			})
		),
		false
	);
	assert.equal(retryableApiError(new HttpError(503)), true);
	assert.equal(retryableApiError(new HttpError(409)), false);
	assert.equal(retryableApiError(new DecodeError("bad json")), false);
	assert.equal(retryableApiError("not an error"), false);
});

test("parseRetryAfter reads both forms and refuses the rest", () => {
	assert.equal(parseRetryAfter("120", 0), 120_000);
	assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10_000);
	assert.equal(parseRetryAfter(new Date(0).toUTCString(), 10_000), 0);
	assert.equal(parseRetryAfter("soon", 0), undefined);
	assert.equal(parseRetryAfter(null, 0), undefined);
});

test("retryableTransportError separates a failure from a refusal", () => {
	assert.equal(
		retryableTransportError(new RetryableResponseError(new Response(null, { status: 503 }))),
		true
	);
	assert.equal(retryableTransportError(new TimeoutError({ ms: 1, elapsed: 1 })), true);
	assert.equal(retryableTransportError(new Error("connection reset")), true);
	assert.equal(
		retryableTransportError(
			new CircuitOpenError({ openedAt: 0, retryAt: 1_000 })
		),
		false
	);
	assert.equal(
		retryableTransportError(
			new BulkheadFullError({ concurrency: 1, queued: 0 })
		),
		false
	);
	assert.equal(
		retryableTransportError(new DOMException("aborted", "AbortError")),
		false
	);
});

test("a slow GET is hedged, and the first answer is the one returned", async () => {
	const clock = new VirtualClock();
	const sent: Request[] = [];

	const send: Transport = async (request) => {
		const index = sent.push(request) - 1;
		await clock.sleep(index === 0 ? 5_000 : 10, request.signal);
		return new Response(`answer ${index + 1}`);
	};

	const call = transport(send, hedge({ attempts: 2, delay: 100, clock }), {
		clock,
	})(new Request("https://api.test/things"));

	await clock.runAll();
	const response = await call;

	assert.equal(sent.length, 2);
	assert.equal(await response.text(), "answer 2");
});

test("a POST is not hedged, however the policy is configured", async () => {
	const clock = new VirtualClock();
	const sent: Request[] = [];

	const send: Transport = async (request) => {
		sent.push(request);
		await clock.sleep(1_000, request.signal);
		return new Response("only once");
	};

	const call = transport(send, hedge({ attempts: 3, delay: 100, clock }), {
		clock,
	})(new Request("https://api.test/things", { method: "POST", body: "{}" }));

	await clock.runAll();
	const response = await call;

	assert.equal(sent.length, 1);
	assert.equal(await response.text(), "only once");
});

test("a body small enough to keep is sent again byte for byte", async () => {
	const clock = new VirtualClock();
	const bodies: string[] = [];

	const send: Transport = async (request) => {
		bodies.push(await request.text());
		return new Response(null, { status: bodies.length < 2 ? 503 : 200 });
	};

	const call = transport(send, retry({
		attempts: 3,
		backoff,
		shouldRetry: retryableTransportError,
		clock,
	}), { clock })(
		new Request("https://api.test/things", {
			method: "PUT",
			body: JSON.stringify({ id: 1 }),
		})
	);

	await clock.runAll();
	await call;

	const body = JSON.stringify({ id: 1 });
	assert.deepEqual(bodies, [body, body]);
});

test("a body too large to keep is sent once, and sent whole", async () => {
	const clock = new VirtualClock();
	const received: number[] = [];

	const send: Transport = async (request) => {
		received.push((await request.arrayBuffer()).byteLength);
		return new Response(null, { status: 503 });
	};

	const body = "x".repeat(4_096);
	const response = await transport(
		send,
		retry({
			attempts: 3,
			backoff,
			shouldRetry: retryableTransportError,
			clock,
		}),
		{ clock, maxReplayBytes: 1_024 }
	)(new Request("https://api.test/things", { method: "PUT", body }));

	assert.deepEqual(received, [4_096]);
	assert.equal(response.status, 503);
});

test("a bodyless request needs nothing kept", async () => {
	const clock = new VirtualClock();
	const { send, sent } = replies(() => new Response(null, { status: 503 }));

	const call = transport(send, retry({
		attempts: 2,
		backoff,
		shouldRetry: retryableTransportError,
		clock,
	}), { clock, maxReplayBytes: 0 })(new Request("https://api.test/things"));

	await clock.runAll();
	await call;

	assert.equal(sent.length, 2);
});

test("a body that declares itself too large is never read", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	let read = 0;

	const body = new ReadableStream<Uint8Array>({
		pull: (controller) => {
			read++;
			controller.enqueue(new Uint8Array(64));
			controller.close();
		},
	});

	const send: Transport = async (request) => {
		await request.arrayBuffer();
		return new Response(null, { status: 503 });
	};

	const response = await transport(
		send,
		retry({
			attempts: 3,
			backoff,
			shouldRetry: retryableTransportError,
			clock,
		}),
		{
			clock,
			maxReplayBytes: 1_024,
			onEvent: (event) => events.push(event),
		}
	)(
		new Request("https://api.test/things", {
			method: "PUT",
			body,
			headers: { "content-length": "999999" },
			duplex: "half",
		} as RequestInit)
	);

	assert.equal(response.status, 503);
	assert.deepEqual(
		events.map(({ call: _call, ...rest }) => rest),
		[{ type: "body-too-large", limit: 1_024, declared: 999_999 }]
	);

	// Read once by the transport it was handed to, never by us.
	assert.equal(read, 1);
});

test("a declaration under the ceiling is still measured, not trusted", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const sizes: number[] = [];

	const send: Transport = async (request) => {
		sizes.push((await request.arrayBuffer()).byteLength);
		return new Response(null, { status: 503 });
	};

	const response = await transport(
		send,
		retry({
			attempts: 2,
			backoff,
			shouldRetry: retryableTransportError,
			clock,
		}),
		{ clock, maxReplayBytes: 100, onEvent: (event) => events.push(event) }
	)(
		new Request("https://api.test/things", {
			method: "PUT",
			body: "x".repeat(500),
			headers: { "content-length": "10" },
		})
	);

	assert.equal(response.status, 503);
	assert.deepEqual(sizes, [500]);
	assert.deepEqual(
		events.map((event) => event.type),
		["body-too-large"]
	);
});

test("a size given by hand overrides the header", async () => {
	const clock = new VirtualClock();
	const events: FireflyEvent[] = [];
	const { send } = replies(() => new Response(null, { status: 503 }));

	await transport(
		send,
		retry({
			attempts: 2,
			backoff,
			shouldRetry: retryableTransportError,
			clock,
		}),
		{
			clock,
			maxReplayBytes: 1_024,
			bodySize: () => 8_000,
			onEvent: (event) => events.push(event),
		}
	)(new Request("https://api.test/things", { method: "PUT", body: "small" }));

	assert.deepEqual(
		events.map((event) => event.type),
		["body-too-large"]
	);
});
