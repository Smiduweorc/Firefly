import { inherit, remaining } from "./call.js";
import { systemClock, type Clock } from "./clock.js";
import { emit, type EventSink } from "./events.js";
import { TimeoutError } from "./errors.js";
import { tag, type Action, type Policy, type Wrapped } from "./policy.js";

/** Configuration for {@link timeout}. */
export interface TimeoutOptions {
	/** Receives a `timeout` event when the deadline is reached. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

/**
 * Gives each attempt `ms` to finish, aborting the attempt's own signal with a
 * {@link TimeoutError} and rejecting with the same error.
 *
 * The abort is the point: an action that watches its signal stops working,
 * rather than running on behind a promise nobody is waiting for. An action
 * that ignores its signal cannot be cancelled by anything, here or elsewhere,
 * and the rejection is still on time.
 *
 * This is a deadline per attempt. A deadline for the whole operation is a
 * budget, and `retry` spells it `maxElapsed`.
 */
export function timeout(ms: number, options: TimeoutOptions = {}): Policy {
	const clock = options.clock ?? systemClock;

	const policy: Policy = <T>(action: Action<T>): Wrapped<T> =>
		async (signal?: AbortSignal): Promise<T> => {
			const outer = signal ?? new AbortController().signal;
			const deadline = new AbortController();
			const attemptSignal = AbortSignal.any([outer, deadline.signal]);

			inherit(outer, attemptSignal);

			const timer = new AbortController();
			const started = clock.now();

			// An attempt never outlives the budget for the whole operation: a
			// deadline that would run past it is cut short instead.
			const left = remaining(outer, started);
			const limit = left === undefined ? ms : Math.min(ms, Math.max(left, 0));

			const expiry = clock.sleep(limit, timer.signal).then(
				(): never => {
					const elapsed = clock.now() - started;
					const error = new TimeoutError({ ms: limit, elapsed });

					emit(options.onEvent, outer, { type: "timeout", ms: limit, elapsed });
					deadline.abort(error);
					throw error;
				},
				// The attempt settled first, so the timer was cancelled and this
				// promise has nothing left to say.
				(): Promise<never> => new Promise<never>(() => {})
			);

			try {
				return await Promise.race([action(attemptSignal), expiry]);
			} finally {
				timer.abort();
			}
		};

	return tag(policy, "timeout");
}
