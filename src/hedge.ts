import type { Backoff } from "./backoff.js";
import { inherit } from "./call.js";
import { systemClock, type Clock } from "./clock.js";
import { HedgeAbandonedError } from "./errors.js";
import { emit, type EventSink } from "./events.js";
import { tag, type Action, type Policy, type Wrapped } from "./policy.js";
import type { RetryBudget } from "./retry-budget.js";

/** Configuration for {@link hedge}. */
export interface HedgeOptions {
	/** Attempts that may be in flight at once. `1` hedges nothing. */
	readonly attempts: number;

	/**
	 * How long to wait for the attempt in flight before starting another, as a
	 * number or as a schedule read with the number of attempts already started.
	 *
	 * Set it near the latency you are willing to accept (around the p95 of the
	 * call, not the p50), or every call is sent twice.
	 */
	readonly delay: number | Backoff;

	/**
	 * Which failures start the next attempt immediately rather than waiting out
	 * the delay.
	 *
	 * Left out, a hedge answers latency only: a failure is passed straight to
	 * the caller and repeating it is `retry`'s job. Supplying this makes the
	 * hedge repeat failures too, which is a decision with the same shape as
	 * `shouldRetry` and is why it has no default.
	 */
	readonly shouldHedge?: (error: unknown) => boolean;

	/**
	 * A ceiling on the extra attempts, shared with whatever else draws on it.
	 *
	 * A hedge sends a second request exactly when the dependency is slow, which
	 * is exactly when it can least afford the traffic. Sharing one budget with
	 * the retry above means the two cannot quietly add up to three times the
	 * load. The hedge only spends: the call is recorded once, by the retry.
	 */
	readonly budget?: RetryBudget;

	/** Receives a `hedge` event per attempt started beyond the first. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

type Outcome<T> =
	| { readonly index: number; readonly ok: true; readonly value: T }
	| { readonly index: number; readonly ok: false; readonly error: unknown };

/**
 * Sends the same work again before the first one has failed, and takes the
 * first answer.
 *
 * A retry waits for a failure; a slow call is not a failure, and waiting for
 * one is how a p99 becomes a timeout. A hedge starts a second attempt once the
 * first has taken too long, keeps both running, and abandons the losers as
 * soon as one answers, which works here because every attempt already gets
 * its own signal, so the losers are cancelled rather than left running.
 *
 * It costs the dependency an extra call whenever it is slow, so it belongs on
 * reads and on anything else that can be repeated safely. `firefly/http`
 * refuses to hedge a request whose body cannot be replayed, for the same
 * reason it refuses to retry one.
 *
 * If every attempt fails, the last failure is rethrown as it was.
 */
export function hedge(options: HedgeOptions): Policy {
	const clock = options.clock ?? systemClock;
	const delayFor =
		typeof options.delay === "number"
			? (): number => options.delay as number
			: (started: number): number => (options.delay as Backoff)(started);

	const policy: Policy = <T>(action: Action<T>): Wrapped<T> =>
		async (signal?: AbortSignal): Promise<T> => {
			const outer = signal ?? new AbortController().signal;
			const controllers = new Map<number, AbortController>();
			const running = new Map<number, Promise<Outcome<T>>>();

			let started = 0;
			let winner: number | undefined;
			let exhausted = false;

			const mayBegin = (): boolean => {
				if (started >= options.attempts || exhausted) {
					return false;
				}

				if (!options.budget || options.budget.tryTake()) {
					return true;
				}

				emit(options.onEvent, outer, {
					type: "budget-exhausted",
					tokens: options.budget.tokens,
				});

				exhausted = true;
				return false;
			};

			const begin = (): void => {
				const index = started++;
				const controller = new AbortController();
				controllers.set(index, controller);

				if (index > 0) {
					emit(options.onEvent, outer, { type: "hedge", attempt: index + 1 });
				}

				const branch = AbortSignal.any([outer, controller.signal]);
				inherit(outer, branch);

				running.set(index, settle(index, action(branch)));
			};

			try {
				begin();

				for (;;) {
					const waiting = [...running.values()];
					const timer = new AbortController();

					const outcome =
						started < options.attempts && !exhausted
							? await Promise.race([
								...waiting,
								tick(clock, delayFor(started), timer.signal),
							])
							: await Promise.race(waiting);

					timer.abort();

					// The delay passed before anything answered, so add an attempt.
					if (outcome === undefined) {
						if (mayBegin()) {
							begin();
						}
						continue;
					}

					running.delete(outcome.index);

					if (outcome.ok) {
						winner = outcome.index;
						return outcome.value;
					}

					if (outer.aborted) {
						throw outcome.error;
					}

					if (options.shouldHedge?.(outcome.error) === true && mayBegin()) {
						begin();
						continue;
					}

					if (running.size === 0) {
						throw outcome.error;
					}
				}
			} finally {
				// Everything except the answer we kept: the winner's signal stays
				// intact, because aborting it would cut off a result that is still
				// being read.
				for (const [index, controller] of controllers) {
					if (index !== winner) {
						controller.abort(new HedgeAbandonedError({ attempt: index + 1 }));
					}
				}
			}
		};

	return tag(policy, "hedge");
}

async function settle<T>(
	index: number,
	work: Promise<T>
): Promise<Outcome<T>> {
	try {
		return { index, ok: true, value: await work };
	} catch (error) {
		return { index, ok: false, error };
	}
}

/** Resolves with nothing when the delay passes, and never when it is cancelled. */
async function tick(
	clock: Clock,
	ms: number,
	cancel: AbortSignal
): Promise<undefined> {
	try {
		await clock.sleep(ms, cancel);
	} catch {
		return new Promise<undefined>(() => {});
	}

	return undefined;
}
