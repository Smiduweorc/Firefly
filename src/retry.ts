import type { Backoff } from "./backoff.js";
import { budgetUntil } from "./call.js";
import { systemClock, type Clock } from "./clock.js";
import { emit, type EventSink } from "./events.js";
import { tag, type Action, type Policy, type Wrapped } from "./policy.js";
import type { RetryBudget } from "./retry-budget.js";

/** Whether a failure is worth repeating. */
export type RetryPredicate = (error: unknown, attempt: number) => boolean;

/**
 * Repeats every failure.
 *
 * Import it where you mean it: under a `firefly/http` transport, say, which
 * has already decided which responses are worth another try. Passing it
 * because there was nothing else to pass means retrying a `TypeError` in your
 * own code three times, slowly.
 */
export const retryAnything: RetryPredicate = () => true;

/** Configuration for {@link retry}. */
export interface RetryOptions {
	/** Total attempts, not additional ones: `1` never retries. */
	readonly attempts: number;

	/** How long to wait between them. */
	readonly backoff: Backoff;

	/**
	 * Whether a failure is worth repeating, called with the error and the
	 * number of the attempt that produced it.
	 *
	 * There is no default. Whether a rejection is worth repeating is the one
	 * thing this package cannot know (a 409 is fatal to one caller and
	 * expected by another), and a guess made here would be a guess nobody can
	 * remove. {@link retryAnything} is the answer when the layer below has
	 * already classified.
	 */
	readonly shouldRetry: RetryPredicate;

	/**
	 * Ceiling on retries across every call sharing it, so a failing dependency
	 * does not get several times its usual traffic.
	 */
	readonly budget?: RetryBudget;

	/**
	 * Budget for the whole operation, measured from the first attempt.
	 *
	 * A retry is abandoned when its backoff would carry the call past the
	 * budget, so the last failure is reported at that point rather than waited
	 * out first. A {@link timeout} below this policy also shortens its deadline
	 * to whatever is left, so no attempt overshoots the budget it started under.
	 */
	readonly maxElapsed?: number;

	/** Receives an `attempt` event per try and a `retry` event per wait. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

/**
 * Repeats the action until it succeeds, the options say to stop, or the
 * caller's signal aborts.
 *
 * When the attempts run out the last failure is rethrown exactly as it was:
 * the error a caller catches is the one their work produced, whether or not a
 * policy tried three times to avoid it.
 */
export function retry(options: RetryOptions): Policy {
	const clock = options.clock ?? systemClock;

	const policy: Policy = <T>(action: Action<T>): Wrapped<T> =>
		async (signal?: AbortSignal): Promise<T> => {
			const outer = signal ?? new AbortController().signal;
			const started = clock.now();

			if (options.maxElapsed !== undefined) {
				budgetUntil(outer, started + options.maxElapsed);
			}

			options.budget?.record();

			for (let attempt = 1; ; attempt++) {
				emit(options.onEvent, outer, { type: "attempt", attempt });

				try {
					return await action(outer);
				} catch (error) {
					// The caller giving up is not a failure to repeat.
					if (outer.aborted) {
						throw error;
					}

					if (attempt >= options.attempts) {
						throw error;
					}

					if (!options.shouldRetry(error, attempt)) {
						throw error;
					}

					if (options.budget && !options.budget.tryTake()) {
						emit(options.onEvent, outer, {
							type: "budget-exhausted",
							tokens: options.budget.tokens,
						});
						throw error;
					}

					const delay = options.backoff(attempt, error);

					if (
						options.maxElapsed !== undefined &&
						clock.now() + delay - started > options.maxElapsed
					) {
						throw error;
					}

					emit(options.onEvent, outer, { type: "retry", attempt, delay, error });
					await clock.sleep(delay, outer);
				}
			}
		};

	return tag(policy, "retry");
}
