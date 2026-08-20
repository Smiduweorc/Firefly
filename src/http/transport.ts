import { systemClock, type Clock } from "../clock.js";
import { emit, type EventSink } from "../events.js";
import type { Action, Policy } from "../policy.js";
import type { ByRequest } from "./by-request.js";
import { parseRetryAfter } from "./retry-after.js";
import {
	idempotentMethods,
	RetryableResponseError,
	retryableStatuses,
} from "./retryable.js";

/**
 * Sends one `Request` and resolves with the response.
 *
 * This is character for character the type Aphid and dung beetle export for
 * their transports, declared here rather than imported so that neither package
 * has to be installed for the two to fit together.
 */
export type Transport = (request: Request) => Promise<Response>;

/** Configuration for {@link transport}. */
export interface TransportOptions {
	/** Statuses treated as retryable. Defaults to {@link retryableStatuses}. */
	readonly retryStatuses?: Iterable<number>;

	/**
	 * Sends `POST` and `PATCH` again as well.
	 *
	 * Whether repeating one is safe is the question the transport cannot
	 * answer: it can see the method and an `Idempotency-Key`, and you know the
	 * rest. A request carrying that header is retried without this option.
	 */
	readonly retryUnsafeMethods?: boolean;

	/**
	 * Ceiling on a `Retry-After` wait, in milliseconds. Defaults to 30 seconds.
	 *
	 * Set it to the same figure as the schedule's `max`. Without a ceiling, a
	 * mistaken or hostile header can park a request for an hour.
	 */
	readonly maxRetryAfter?: number;

	/**
	 * How much of a request body may be held in memory so the request can be
	 * sent again. Defaults to one mebibyte.
	 *
	 * Replaying a body means keeping it, and a stream gives no way to ask how
	 * long it is. So a body is read up to this ceiling: under it, every attempt
	 * is sent from the same bytes; over it, the request is sent once, whole,
	 * and never repeated. An upload cannot quietly become the process's memory
	 * problem, and it cannot be truncated either.
	 *
	 * A request that declares its own length is not read at all when the
	 * declaration is already over the ceiling. See {@link bodySize}.
	 */
	readonly maxReplayBytes?: number;

	/**
	 * How long a request's body is, when that is known before reading it.
	 *
	 * Defaults to reading `content-length`, which survives on a `Request` under
	 * Node but is a forbidden header in a browser, so it is a hint rather than
	 * an answer: a body that declares nothing is still read against
	 * {@link maxReplayBytes}, and one that declares a lie is still measured.
	 * What the hint buys is not reading two gigabytes to discover that two
	 * gigabytes is too much.
	 */
	readonly bodySize?: (request: Request) => number | undefined;

	/**
	 * Receives the decisions this transport makes on its own: currently a
	 * `body-too-large`, which is the only thing here that quietly changes
	 * whether a request can be repeated.
	 */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

/**
 * Wraps a `fetch`-shaped transport in a policy, for the seam Aphid and dung
 * beetle leave open.
 *
 * The client turns a non-2xx response into an `HttpError` *after* the
 * transport returns, so a decorator never sees one: a 429 arrives here as an
 * ordinary resolved `Response`. This reads the response itself, raises a
 * {@link RetryableResponseError} for the statuses worth repeating, and hands
 * the final response back untouched with its body unread, so `decode` and
 * `HttpError.body` behave as they do with no policy in the way.
 *
 * A response that is about to be discarded has its body cancelled, and a
 * request that may not be repeated (the wrong method, or a body too large to
 * keep) is sent exactly once however many attempts the policy above it has.
 */
export function transport(
	send: Transport,
	policy: Policy | ByRequest,
	options: TransportOptions = {}
): Transport {
	const statuses = new Set(options.retryStatuses ?? retryableStatuses);
	const clock = options.clock ?? systemClock;
	const maxRetryAfter = options.maxRetryAfter ?? 30_000;
	const maxReplayBytes = options.maxReplayBytes ?? 1024 * 1024;

	return async (request: Request): Promise<Response> => {
		const chosen =
			typeof policy === "function" ? policy : policy.forRequest(request);

		let mayRetry = allowsRetry(request, options);
		let replay: Uint8Array | undefined;
		let oversized: ReadableStream<Uint8Array> | undefined;

		if (mayRetry && request.body) {
			const declared = declaredSize(request, options);

			if (declared !== undefined && declared > maxReplayBytes) {
				// It said so itself, so there is no reason to read any of it.
				mayRetry = false;
				emit(options.onEvent, request.signal, {
					type: "body-too-large",
					limit: maxReplayBytes,
					declared,
				});
			} else {
				const body = await keep(request.body, maxReplayBytes);

				if (body instanceof Uint8Array) {
					replay = body;
				} else {
					// Too big to hold, so it goes out once and in one piece.
					oversized = body;
					mayRetry = false;
					emit(options.onEvent, request.signal, {
						type: "body-too-large",
						limit: maxReplayBytes,
					});
				}
			}
		}

		let sent = false;
		let failure: unknown;
		let discarded: Response | undefined;
		let notBefore = 0;

		const attempt: Action<Response> = async (signal) => {
			if (sent && !mayRetry) {
				throw (
					failure ??
					new Error(
						`${request.method} ${request.url} cannot be sent again: its body is not replayable`
					)
				);
			}

			if (discarded) {
				await cancel(discarded);
				discarded = undefined;
			}

			const wait = notBefore - clock.now();
			if (wait > 0) {
				await clock.sleep(wait, signal);
			}

			const outgoing = build(request, signal, replay, oversized);
			oversized = undefined;
			sent = true;

			let response: Response;
			try {
				response = await send(outgoing);
			} catch (error) {
				failure = error;
				throw error;
			}

			if (!mayRetry || !statuses.has(response.status)) {
				return response;
			}

			if (response.status === 429 || response.status === 503) {
				const after = parseRetryAfter(
					response.headers.get("retry-after"),
					clock.now()
				);

				if (after !== undefined) {
					// Absorbed into the next attempt rather than added to it, so a
					// backoff longer than the header does not wait twice.
					notBefore = clock.now() + Math.min(after, maxRetryAfter);
				}
			}

			discarded = response;
			failure = new RetryableResponseError(response);
			throw failure;
		};

		try {
			return await chosen(attempt)(request.signal);
		} catch (error) {
			if (error instanceof RetryableResponseError) {
				// The policy stopped on this one, so it is the answer.
				return error.response;
			}

			if (discarded) {
				await cancel(discarded);
			}

			throw error;
		}
	};
}

function declaredSize(
	request: Request,
	options: TransportOptions
): number | undefined {
	if (options.bodySize) {
		return options.bodySize(request);
	}

	const header = request.headers.get("content-length");

	if (header === null || !/^\d+$/.test(header.trim())) {
		return undefined;
	}

	return Number(header);
}

function allowsRetry(request: Request, options: TransportOptions): boolean {
	if (idempotentMethods.includes(request.method.toUpperCase())) {
		return true;
	}

	return (
		options.retryUnsafeMethods === true ||
		request.headers.has("idempotency-key")
	);
}

/**
 * Reads the body into memory so it can be sent more than once, or hands back a
 * stream carrying what was read plus the rest, when it turns out to be larger
 * than the ceiling.
 */
async function keep(
	body: ReadableStream<Uint8Array>,
	cap: number
): Promise<Uint8Array | ReadableStream<Uint8Array>> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];

	let size = 0;

	for (;;) {
		const { done, value } = await reader.read();

		if (done) {
			return join(chunks, size);
		}

		chunks.push(value);
		size += value.byteLength;

		if (size > cap) {
			return new ReadableStream<Uint8Array>({
				start: (controller) => {
					for (const chunk of chunks) {
						controller.enqueue(chunk);
					}
				},
				pull: async (controller) => {
					const next = await reader.read();

					if (next.done) {
						controller.close();
						return;
					}

					controller.enqueue(next.value);
				},
				cancel: (reason) => reader.cancel(reason),
			});
		}
	}
}

function join(chunks: Uint8Array[], size: number): Uint8Array {
	const body = new Uint8Array(size);

	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}

	return body;
}

function build(
	request: Request,
	signal: AbortSignal,
	replay: Uint8Array | undefined,
	oversized: ReadableStream<Uint8Array> | undefined
): Request {
	if (replay) {
		return new Request(request, { body: replay, signal });
	}

	if (oversized) {
		return new Request(request, {
			body: oversized,
			signal,
			duplex: "half",
		} as RequestInit);
	}

	try {
		return new Request(request, { signal });
	} catch {
		// A body that cannot be re-wrapped travels on the original request,
		// which still carries the caller's own signal.
		return request;
	}
}

async function cancel(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The body was already gone, which is the outcome being asked for.
	}
}
