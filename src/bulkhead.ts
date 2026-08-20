import { systemClock, type Clock } from "./clock.js";
import { BulkheadFullError } from "./errors.js";
import { emit, type EventSink } from "./events.js";
import { tag, type Action, type Policy, type Wrapped } from "./policy.js";

/** How a bulkhead moves its own limit in response to what it sees. */
export interface AdaptiveConcurrency {
	/** Never go below this, however badly things are going. */
	readonly min: number;

	/** Never go above this, however well. */
	readonly max: number;

	/** Calls slower than this are treated as failures for the purpose of the limit. */
	readonly slowerThan?: number;

	/** What the limit is multiplied by on a failure. Defaults to `0.9`. */
	readonly decrease?: number;
}

/** Configuration for a {@link Bulkhead}. */
export interface BulkheadOptions {
	/** Calls allowed to run at once, and the starting point when the limit adapts. */
	readonly concurrency: number;

	/** Calls allowed to wait for a slot. Defaults to `0`, which refuses instead of queueing. */
	readonly queue?: number;

	/**
	 * How long a call may wait for a slot before it is refused.
	 *
	 * A call that will time out anyway should be refused now, while the caller
	 * can still do something else; a queue with no ceiling on the wait is a
	 * latency problem wearing a concurrency limit's clothes.
	 */
	readonly queueTimeout?: number;

	/**
	 * Moves the limit with what the dependency is actually managing, rather
	 * than with the number you guessed: additive increase while calls succeed
	 * under pressure, multiplicative decrease when they fail or drag.
	 */
	readonly adapt?: AdaptiveConcurrency;

	/** Receives `bulkhead-queued` and `bulkhead-rejected`. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. Only needed for `queueTimeout` and `adapt`. */
	readonly clock?: Clock;
}

interface Waiter {
	readonly admit: () => void;
	readonly cancel: (reason: unknown) => void;
}

/**
 * Bounds how many calls may be in flight at once, and how many may wait.
 *
 * A bulkhead is the thing that keeps one slow dependency from consuming every
 * connection, socket or worker the process has; it belongs directly around the
 * work, where the count it holds is the count that matters.
 *
 * Waiting for a slot ends early if the caller's signal aborts, so a queued
 * call does not outlive the request that made it, and the queue is served in
 * order: a slot is handed to whoever has waited longest rather than to
 * whoever happens to ask next.
 */
export class Bulkhead {
	readonly #options: BulkheadOptions;
	readonly #clock: Clock;
	readonly #queue: number;
	readonly #waiting: Waiter[] = [];

	#inFlight = 0;
	#limit: number;

	constructor(options: BulkheadOptions) {
		this.#options = options;
		this.#clock = options.clock ?? systemClock;
		this.#queue = options.queue ?? 0;
		this.#limit = options.concurrency;
	}

	/** Calls currently running. */
	get inFlight(): number {
		return this.#inFlight;
	}

	/** Calls currently waiting for a slot. */
	get queued(): number {
		return this.#waiting.length;
	}

	/** Calls allowed at once, which moves on its own when the bulkhead adapts. */
	get concurrency(): number {
		return Math.max(1, Math.floor(this.#limit));
	}

	/** Takes a slot before the work starts and gives it back when the work settles. */
	readonly policy: Policy = tag(
		<T>(action: Action<T>): Wrapped<T> =>
			async (signal?: AbortSignal): Promise<T> => {
				const outer = signal ?? new AbortController().signal;

				await this.#acquire(outer);
				const startedAt = this.#clock.now();

				try {
					const result = await action(outer);
					this.#adapt(true, this.#clock.now() - startedAt);
					return result;
				} catch (error) {
					this.#adapt(false, this.#clock.now() - startedAt);
					throw error;
				} finally {
					this.#release();
				}
			},
		"bulkhead"
	);

	async #acquire(signal: AbortSignal): Promise<void> {
		if (this.#inFlight < this.concurrency && this.#waiting.length === 0) {
			this.#inFlight++;
			return;
		}

		if (this.#waiting.length >= this.#queue) {
			emit(this.#options.onEvent, signal, {
				type: "bulkhead-rejected",
				inFlight: this.#inFlight,
				queued: this.#waiting.length,
			});

			throw new BulkheadFullError({
				concurrency: this.concurrency,
				queued: this.#waiting.length,
			});
		}

		emit(this.#options.onEvent, signal, {
			type: "bulkhead-queued",
			inFlight: this.#inFlight,
			queued: this.#waiting.length + 1,
		});

		const expiry = new AbortController();

		try {
			await new Promise<void>((resolve, reject) => {
				const waiter: Waiter = {
					admit: () => {
						signal.removeEventListener("abort", abort);
						resolve();
					},
					cancel: reject,
				};

				const abort = (): void => {
					this.#drop(waiter);
					waiter.cancel(signal.reason);
				};

				if (signal.aborted) {
					reject(signal.reason);
					return;
				}

				this.#waiting.push(waiter);
				signal.addEventListener("abort", abort, { once: true });

				if (this.#options.queueTimeout !== undefined) {
					void this.#clock
						.sleep(this.#options.queueTimeout, expiry.signal)
						.then(() => {
							if (!this.#drop(waiter)) {
								return;
							}

							signal.removeEventListener("abort", abort);
							emit(this.#options.onEvent, signal, {
								type: "bulkhead-rejected",
								inFlight: this.#inFlight,
								queued: this.#waiting.length,
							});

							waiter.cancel(
								new BulkheadFullError({
									concurrency: this.concurrency,
									queued: this.#waiting.length,
								})
							);
						})
						.catch(() => undefined);
				}
			});
		} finally {
			expiry.abort();
		}
	}

	#drop(waiter: Waiter): boolean {
		const index = this.#waiting.indexOf(waiter);

		if (index === -1) {
			return false;
		}

		this.#waiting.splice(index, 1);
		return true;
	}

	#release(): void {
		// The slot is handed straight to the next waiter rather than freed and
		// taken again, so a queued call cannot be overtaken by a new arrival.
		const next =
			this.#inFlight <= this.concurrency ? this.#waiting.shift() : undefined;

		if (next) {
			next.admit();
			return;
		}

		this.#inFlight--;
	}

	#adapt(ok: boolean, elapsed: number): void {
		const adapt = this.#options.adapt;

		if (!adapt) {
			return;
		}

		const slow =
			adapt.slowerThan !== undefined && elapsed >= adapt.slowerThan;

		if (!ok || slow) {
			this.#limit = Math.max(adapt.min, this.#limit * (adapt.decrease ?? 0.9));
			return;
		}

		// Only grow while the limit is the thing holding calls back; widening a
		// bulkhead nothing is queueing for measures nothing.
		if (this.#inFlight >= this.concurrency) {
			this.#limit = Math.min(adapt.max, this.#limit + 1 / this.#limit);
		}
	}
}
