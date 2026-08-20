import { callId } from "./call.js";

/**
 * Something a policy decided, handed to an {@link EventSink} as a plain value.
 *
 * The union is closed and every member carries the numbers behind the
 * decision, so a sink can count, log or ignore them without asking the policy
 * anything else. Every one of them also carries the `call` it belongs to.
 */
export type FireflyEvent = (
	| { readonly type: "attempt"; readonly attempt: number }
	| RetryEvent
	| { readonly type: "timeout"; readonly ms: number; readonly elapsed: number }
	| { readonly type: "hedge"; readonly attempt: number }
	| { readonly type: "budget-exhausted"; readonly tokens: number }
	| { readonly type: "fallback"; readonly error: unknown }
	| BodyTooLargeEvent
	| CircuitOpenEvent
	| { readonly type: "circuit-half-open"; readonly openedAt: number }
	| { readonly type: "circuit-close" }
	| RateLimitedEvent
	| BulkheadEvent
) & {
	/**
	 * Groups every event from one call, so a sink can tell three attempts of
	 * one call from one attempt of three calls.
	 */
	readonly call: string;
};

/** An attempt failed and another one is scheduled `delay` milliseconds later. */
export interface RetryEvent {
	readonly type: "retry";
	readonly attempt: number;
	readonly delay: number;
	readonly error: unknown;
}

/**
 * A request body was too big to keep, so the request became one that is sent
 * once rather than repeated.
 */
export interface BodyTooLargeEvent {
	readonly type: "body-too-large";

	/** The ceiling it went over. */
	readonly limit: number;

	/** What the request said its length was, when it said anything at all. */
	readonly declared?: number;
}

/** A breaker opened, either on the failure that reached its threshold or on a failed trial call. */
export interface CircuitOpenEvent {
	readonly type: "circuit-open";
	readonly openedAt: number;
	readonly retryAt: number;
	readonly error: unknown;
}

/** A call found the bucket empty. `rejected` distinguishes a refusal from a wait. */
export interface RateLimitedEvent {
	readonly type: "rate-limited";
	readonly retryAt: number;
	readonly rejected: boolean;
}

/** A call waited for a slot, or was refused because the queue was full too. */
export interface BulkheadEvent {
	readonly type: "bulkhead-queued" | "bulkhead-rejected";
	readonly inFlight: number;
	readonly queued: number;
}

/** Receives every decision a policy makes. */
export type EventSink = (event: FireflyEvent) => void;

// Omit over a union collapses it, and the events are a union.
type Body<E> = E extends unknown ? Omit<E, "call"> : never;

/**
 * Delivers `body` as an event for `signal`'s call, dropping a throw: a failing
 * metrics sink must not fail the call it was reporting on.
 */
export function emit(
	sink: EventSink | undefined,
	signal: AbortSignal,
	body: Body<FireflyEvent>
): void {
	if (!sink) {
		return;
	}

	try {
		sink({ ...body, call: callId(signal) } as FireflyEvent);
	} catch {
		// The sink is the application's to fix; the call it reported on is not.
	}
}
