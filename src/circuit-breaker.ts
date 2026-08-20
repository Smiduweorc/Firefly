import { systemClock, type Clock } from "./clock.js";
import { CircuitOpenError } from "./errors.js";
import { emit, type EventSink } from "./events.js";
import { tag, type Action, type Policy, type Wrapped } from "./policy.js";

/** What a breaker will do with the next call. */
export type CircuitState = "closed" | "open" | "half-open";

/** How much of the recent past a breaker judges on. */
export interface SlidingWindow {
	/** Calls remembered. */
	readonly size: number;

	/**
	 * How recent a call has to be to count, in milliseconds. Left out, the
	 * window is the last `size` calls however long ago they were, which reads
	 * a quiet service's morning as if it were happening now.
	 */
	readonly within?: number;

	/**
	 * Calls that must be in the window before a rate can open the circuit, so
	 * two failures at three in the morning do not read as 100%.
	 */
	readonly minimumCalls: number;

	/** Share of the window that must have failed, from `0` to `1`. */
	readonly failureRate: number;

	/** Calls slower than this count as slow, whether or not they succeeded. */
	readonly slowerThan?: number;

	/**
	 * Share of the window that must be slow, from `0` to `1`. A dependency
	 * answering every call in nine seconds is down; it just has not admitted it.
	 *
	 * A circuit opened by slowness alone has no failure to report, so the
	 * `cause` of its {@link CircuitOpenError} is `undefined`.
	 */
	readonly slowRate?: number;
}

interface CircuitBreakerBase {
	/** How long the circuit stays open before one trial call is allowed through. */
	readonly resetAfter: number;

	/**
	 * Whether an error counts against the breaker. An error it declines is not
	 * recorded at all: it neither opens nor closes the circuit, and passes
	 * through untouched. Defaults to counting every failure.
	 */
	readonly isFailure?: (error: unknown) => boolean;

	/**
	 * Calls let through while the circuit is half-open, and successes needed
	 * to close it. Defaults to `1`.
	 *
	 * More than one probe closes a recovered dependency faster; every probe is
	 * also a call to something that was failing a moment ago.
	 */
	readonly probes?: number;

	/** Receives `circuit-open`, `circuit-half-open` and `circuit-close`. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

/** Trips on a run of failures with nothing in between. */
export interface ConsecutiveBreakerOptions extends CircuitBreakerBase {
	/** Consecutive failures that open the circuit. */
	readonly threshold: number;

	readonly window?: never;
}

/** Trips on the share of recent calls that failed or were slow. */
export interface WindowedBreakerOptions extends CircuitBreakerBase {
	/** The recent past to judge on. */
	readonly window: SlidingWindow;

	readonly threshold?: never;
}

/**
 * Configuration for a {@link CircuitBreaker}: a run of consecutive failures,
 * or a rate over a window, and never both.
 */
export type CircuitBreakerOptions =
	| ConsecutiveBreakerOptions
	| WindowedBreakerOptions;

const FAILED = 1;
const SLOW = 2;

interface Entry {
	readonly outcome: number;
	readonly at: number;
}

/** What one call was admitted as, so a late answer cannot act on a stale decision. */
interface Admission {
	readonly trial: boolean;
	readonly generation: number;
}

/**
 * Stops calling a dependency that is failing, and tries one call when the
 * reset window has passed.
 *
 * The state lives on the object rather than in the options of a policy, so its
 * scope is whatever you share it with: one breaker per dependency is usually
 * right, and a breaker created inside a client factory is usually a breaker per
 * client, which measures nothing.
 *
 * Consecutive failures are the simple trip condition and the wrong one above a
 * certain volume: 40% of calls failing, interleaved with successes, never
 * reaches five in a row. Pass a `window` instead and the breaker judges the
 * share of recent calls that failed, or that took too long, which is what a
 * dependency in trouble actually looks like.
 *
 * Constructing one starts no timer. The window is compared against the clock
 * when a call arrives.
 */
export class CircuitBreaker {
	readonly #options: CircuitBreakerOptions;
	readonly #clock: Clock;
	readonly #window: Entry[] = [];

	#failures = 0;
	#openedAt = 0;
	#retryAt = 0;
	#cause: unknown;
	#opened = false;
	#generation = 0;
	#trials = 0;
	#passed = 0;

	constructor(options: CircuitBreakerOptions) {
		this.#options = options;
		this.#clock = options.clock ?? systemClock;
	}

	/**
	 * `"open"` while the circuit refuses calls, `"half-open"` once the reset
	 * window has passed and the next call will be tried, `"closed"` otherwise.
	 *
	 * Reading it changes nothing, which is what makes it safe for a health
	 * endpoint.
	 */
	get state(): CircuitState {
		if (!this.#opened) {
			return "closed";
		}

		return this.#clock.now() >= this.#retryAt ? "half-open" : "open";
	}

	/**
	 * Failures counted so far: consecutive ones, or the ones inside the window
	 * for a breaker judging on rates.
	 */
	get failures(): number {
		if (!this.#options.window) {
			return this.#failures;
		}

		return this.#recent().filter((entry) => (entry.outcome & FAILED) !== 0)
			.length;
	}

	/** Calls remembered in the window, or `0` for a breaker counting consecutive failures. */
	get recorded(): number {
		return this.#recent().length;
	}

	/**
	 * Records what happens to each call and refuses the ones the circuit is
	 * not open to.
	 *
	 * Belongs inside a retry, so every attempt is counted rather than one
	 * outage counting once, and outside the waiting policies, so an open
	 * circuit refuses immediately instead of queueing for a slot it will not
	 * use.
	 */
	readonly policy: Policy = tag(
		<T>(action: Action<T>): Wrapped<T> =>
			async (signal?: AbortSignal): Promise<T> => {
				const outer = signal ?? new AbortController().signal;
				const admission = this.#admit(outer);
				const startedAt = this.#clock.now();

				let result: T;
				try {
					result = await action(outer);
				} catch (error) {
					this.#failed(error, admission, this.#clock.now() - startedAt, outer);
					throw error;
				}

				this.#succeeded(admission, this.#clock.now() - startedAt, outer);
				return result;
			},
		"circuit-breaker"
	);

	#admit(signal: AbortSignal): Admission {
		if (!this.#opened) {
			return { trial: false, generation: this.#generation };
		}

		const probes = this.#options.probes ?? 1;

		if (this.#trials >= probes || this.#clock.now() < this.#retryAt) {
			throw new CircuitOpenError({
				openedAt: this.#openedAt,
				retryAt: this.#retryAt,
				cause: this.#cause,
			});
		}

		if (this.#trials === 0) {
			emit(this.#options.onEvent, signal, {
				type: "circuit-half-open",
				openedAt: this.#openedAt,
			});
		}

		this.#trials++;
		return { trial: true, generation: this.#generation };
	}

	#succeeded(admission: Admission, elapsed: number, signal: AbortSignal): void {
		this.#failures = 0;

		if (admission.trial) {
			// The circuit reopened while this probe was in flight, so its answer
			// is about the outage before last.
			if (admission.generation !== this.#generation) {
				return;
			}

			this.#trials--;
			this.#passed++;

			if (this.#passed >= (this.#options.probes ?? 1)) {
				this.#close(signal);
			}

			return;
		}

		this.#remember(0, elapsed);

		// A success still counts against a slow-call rate: a dependency
		// answering every call in nine seconds is the case this exists for.
		if (this.#tripped()) {
			this.#open(undefined, signal);
		}
	}

	#failed(
		error: unknown,
		admission: Admission,
		elapsed: number,
		signal: AbortSignal
	): void {
		if (this.#options.isFailure && !this.#options.isFailure(error)) {
			if (admission.trial && admission.generation === this.#generation) {
				this.#trials--;
			}
			return;
		}

		if (admission.trial) {
			if (admission.generation === this.#generation) {
				this.#open(error, signal);
			}
			return;
		}

		this.#failures++;
		this.#remember(FAILED, elapsed);

		if (this.#tripped()) {
			this.#open(error, signal);
		}
	}

	#remember(outcome: number, elapsed: number): void {
		const window = this.#options.window;

		if (!window) {
			return;
		}

		const slow =
			window.slowerThan !== undefined && elapsed >= window.slowerThan
				? SLOW
				: 0;

		this.#window.push({ outcome: outcome | slow, at: this.#clock.now() });
		this.#recent();
	}

	/** The window with anything too old or too far back dropped. */
	#recent(): Entry[] {
		const window = this.#options.window;

		if (!window) {
			return this.#window;
		}

		const oldest =
			window.within === undefined
				? Number.NEGATIVE_INFINITY
				: this.#clock.now() - window.within;

		while (
			this.#window.length > 0 &&
			(this.#window.length > window.size ||
				(this.#window[0] as Entry).at < oldest)
		) {
			this.#window.shift();
		}

		return this.#window;
	}

	#tripped(): boolean {
		const window = this.#options.window;

		if (!window) {
			return this.#failures >= this.#options.threshold;
		}

		const entries = this.#recent();
		const recorded = entries.length;

		if (recorded < window.minimumCalls) {
			return false;
		}

		const failed = entries.filter(
			(entry) => (entry.outcome & FAILED) !== 0
		).length;

		if (failed / recorded >= window.failureRate) {
			return true;
		}

		if (window.slowRate === undefined) {
			return false;
		}

		const slow = entries.filter((entry) => (entry.outcome & SLOW) !== 0).length;
		return slow / recorded >= window.slowRate;
	}

	#close(signal: AbortSignal): void {
		this.#opened = false;
		this.#cause = undefined;
		this.#clear();

		emit(this.#options.onEvent, signal, { type: "circuit-close" });
	}

	#open(error: unknown, signal: AbortSignal): void {
		const now = this.#clock.now();

		this.#opened = true;
		this.#openedAt = now;
		this.#retryAt = now + this.#options.resetAfter;
		this.#cause = error;
		this.#clear();

		emit(this.#options.onEvent, signal, {
			type: "circuit-open",
			openedAt: now,
			retryAt: this.#retryAt,
			error,
		});
	}

	#clear(): void {
		// A window kept across the open period would judge the trial call on
		// evidence from before the outage.
		this.#window.length = 0;
		this.#failures = 0;
		this.#trials = 0;
		this.#passed = 0;
		this.#generation++;
	}
}
