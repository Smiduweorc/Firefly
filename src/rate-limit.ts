import { systemClock, type Clock } from "./clock.js";
import { RateLimitError } from "./errors.js";
import { emit, type EventSink } from "./events.js";
import { tag, type Action, type Policy, type Wrapped } from "./policy.js";

/** Configuration for a {@link RateLimiter}. */
export interface RateLimiterOptions {
	/** Bucket size, which is the largest burst allowed after an idle period. */
	readonly capacity: number;

	/** Tokens added per second. */
	readonly perSecond: number;

	/**
	 * What to do when the bucket is empty: wait for a token, or refuse the
	 * call with a {@link RateLimitError}. Defaults to `"wait"`.
	 */
	readonly onExhausted?: "wait" | "reject";

	/** Receives a `rate-limited` event whenever a call finds the bucket empty. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

/**
 * A token bucket, in this process and no other.
 *
 * It refills against the clock rather than on a timer, so it costs nothing
 * while idle and cannot drift. Sharing one across a fleet needs a store, a
 * clock all the machines agree on, and an answer for what happens when the
 * store is down, none of which this package can pick for you.
 *
 * Callers that have to wait are served in the order they arrived, so a steady
 * stream of new calls cannot starve the one that has been waiting longest.
 *
 * Belongs outside the bulkhead: waiting for a token should not hold a
 * concurrency slot.
 */
export class RateLimiter {
	readonly #options: RateLimiterOptions;
	readonly #clock: Clock;

	#tokens: number;
	#updated: number;
	#waiting = 0;
	#turn: Promise<void> = Promise.resolve();

	constructor(options: RateLimiterOptions) {
		this.#options = options;
		this.#clock = options.clock ?? systemClock;
		this.#tokens = options.capacity;
		this.#updated = this.#clock.now();
	}

	/** Tokens available now, including everything the bucket has refilled since the last call. */
	get tokens(): number {
		this.#refill();
		return this.#tokens;
	}

	/** Calls waiting for a token. */
	get queued(): number {
		return this.#waiting;
	}

	/** Spends a token before the work starts, waiting or refusing when there is none. */
	readonly policy: Policy = tag(
		<T>(action: Action<T>): Wrapped<T> =>
			async (signal?: AbortSignal): Promise<T> => {
				const outer = signal ?? new AbortController().signal;

				await this.take(outer);
				return action(outer);
			},
		"rate-limiter"
	);

	/**
	 * Spends one token, waiting for it if the limiter is set to wait.
	 *
	 * @throws {RateLimitError} If the bucket is empty and `onExhausted` is `"reject"`.
	 */
	async take(signal?: AbortSignal): Promise<void> {
		const outer = signal ?? new AbortController().signal;

		if (this.#options.onExhausted === "reject") {
			this.#refill();

			if (this.#tokens >= 1) {
				this.#tokens--;
				return;
			}

			const retryAt = this.#clock.now() + this.#wait();
			emit(this.#options.onEvent, outer, {
				type: "rate-limited",
				retryAt,
				rejected: true,
			});

			throw new RateLimitError({ retryAt });
		}

		// Nobody is queueing and there is a token: no need to take a turn.
		if (this.#waiting === 0) {
			this.#refill();

			if (this.#tokens >= 1) {
				this.#tokens--;
				return;
			}
		}

		await this.#queued(outer);
	}

	async #queued(signal: AbortSignal): Promise<void> {
		const ahead = this.#turn;
		let done!: () => void;

		this.#waiting++;
		this.#turn = new Promise<void>((resolve) => {
			done = resolve;
		});

		try {
			await waitTurn(ahead, signal);

			for (;;) {
				this.#refill();

				if (this.#tokens >= 1) {
					this.#tokens--;
					return;
				}

				const wait = this.#wait();
				emit(this.#options.onEvent, signal, {
					type: "rate-limited",
					retryAt: this.#clock.now() + wait,
					rejected: false,
				});

				await this.#clock.sleep(wait, signal);
			}
		} finally {
			this.#waiting--;
			done();
		}
	}

	/** How long until the bucket holds a whole token again. */
	#wait(): number {
		return Math.ceil(((1 - this.#tokens) / this.#options.perSecond) * 1000);
	}

	#refill(): void {
		const now = this.#clock.now();
		const elapsed = now - this.#updated;

		if (elapsed <= 0) {
			return;
		}

		this.#tokens = Math.min(
			this.#options.capacity,
			this.#tokens + (elapsed / 1000) * this.#options.perSecond
		);
		this.#updated = now;
	}
}

/** Waits for the call ahead to finish with the bucket, or for the caller to give up. */
async function waitTurn(ahead: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		throw signal.reason;
	}

	let abort!: () => void;

	const abandoned = new Promise<never>((_, reject) => {
		abort = (): void => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});

	// Nothing else awaits this promise once the turn arrives.
	abandoned.catch(() => undefined);

	try {
		await Promise.race([ahead, abandoned]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
