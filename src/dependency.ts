import type { Backoff } from "./backoff.js";
import { Bulkhead, type BulkheadOptions } from "./bulkhead.js";
import {
	CircuitBreaker,
	type CircuitBreakerOptions,
	type CircuitState,
} from "./circuit-breaker.js";
import { systemClock, type Clock } from "./clock.js";
import type { EventSink } from "./events.js";
import { fallback } from "./fallback.js";
import { hedge, type HedgeOptions } from "./hedge.js";
import { stack, type Action, type Policy, type Wrapped } from "./policy.js";
import { RateLimiter, type RateLimiterOptions } from "./rate-limit.js";
import { RetryBudget, type RetryBudgetOptions } from "./retry-budget.js";
import { retry, type RetryPredicate } from "./retry.js";
import { SingleFlight } from "./single-flight.js";
import { timeout } from "./timeout.js";

// Omit over a union collapses it, and the breaker's options are a union.
type Each<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Configuration for a {@link Dependency}. */
export interface DependencyOptions {
	/** What this dependency is called, in health output and in your own logs. */
	readonly name: string;

	/** Total attempts per call, not additional ones: `1` never retries. */
	readonly attempts: number;

	/** How long to wait between attempts. */
	readonly backoff: Backoff;

	/** Whether a failure is worth repeating. There is no default; see {@link retry}. */
	readonly shouldRetry: RetryPredicate;

	/** Deadline for one attempt, in milliseconds. */
	readonly deadline: number;

	/**
	 * When to stop calling this dependency altogether, or `false` to say you
	 * decided against a breaker rather than to have forgotten one.
	 */
	readonly breaker: Each<CircuitBreakerOptions, "onEvent" | "clock"> | false;

	/** How many attempts may be in flight, and how many may wait. */
	readonly bulkhead?: Omit<BulkheadOptions, "onEvent" | "clock">;

	/** How fast attempts may start. */
	readonly rateLimit?: Omit<RateLimiterOptions, "onEvent" | "clock">;

	/**
	 * A ceiling on the extra calls this dependency is allowed to make, shared
	 * by its retries and its hedged attempts.
	 */
	readonly budget?: RetryBudgetOptions;

	/** Send the work again when it is slow rather than when it has failed. */
	readonly hedge?: Omit<HedgeOptions, "onEvent" | "clock" | "budget">;

	/** Budget for a whole call, across all its attempts. */
	readonly maxElapsed?: number;

	/** Receives every decision made about this dependency. */
	readonly onEvent?: EventSink;

	/** Defaults to the system clock. */
	readonly clock?: Clock;
}

/**
 * The parts of a call that belong to the call rather than to the dependency.
 *
 * Everything else about calling this thing was decided once, in
 * {@link DependencyOptions}. These two could not be: coalescing needs
 * something to coalesce on, and a substitute result has the type of whatever
 * this one call returns.
 */
export interface CallOptions<T> {
	/**
	 * Collapses this call into any other call to the same dependency running
	 * under the same key, so twenty callers wanting one thing make one request
	 * and share its attempts. See {@link SingleFlight} for what leaving early
	 * does to the call the others are still waiting on.
	 */
	readonly share?: string;

	/**
	 * What to answer with when the call has failed all the way through: stale
	 * data, an empty list, a degraded result. The handler is given the failure,
	 * and throwing from it is how you decline to answer for that one.
	 */
	readonly fallback?: (error: unknown) => T | Promise<T>;

	/** Abandons this call. */
	readonly signal?: AbortSignal;
}

/** What a {@link Dependency} is doing, in a shape a health endpoint can return. */
export interface DependencyHealth {
	readonly name: string;

	/** `"none"` when this dependency was configured without a breaker. */
	readonly circuit: CircuitState | "none";

	/** Failures the breaker is currently counting. */
	readonly failures: number;

	/** Calls running now. */
	readonly inFlight: number;

	/** Calls waiting for a concurrency slot. */
	readonly queued: number;

	/** Tokens left in the rate limiter, when there is one. */
	readonly tokens?: number;

	/** Retries left in the budget, when there is one. */
	readonly retries?: number;
}

/**
 * One thing you call, and everything you have decided about calling it.
 *
 * A policy stack is assembled per call site, which puts the state in the wrong
 * place: a breaker built inside a client factory is a breaker per client, and
 * a breaker only some call sites go through is not measuring the dependency.
 * Here the state and the scope are the same object: one per upstream,
 * constructed where you can see it, shared by everything that talks to it.
 *
 * The numbers are all yours: attempts, deadline and breaker have no defaults,
 * because how many attempts and how long a deadline are properties of your
 * traffic and your budget. What is not yours is the order the policies go in,
 * which has one right answer and is assembled here so it cannot be got wrong.
 * That includes the two policies decided per call rather than per dependency,
 * which are {@link CallOptions.share} and {@link CallOptions.fallback}.
 *
 * ```ts
 * const payments = new Dependency({
 * 	name: "payments",
 * 	attempts: 3,
 * 	backoff: exponential({ base: 200, max: 10_000 }),
 * 	shouldRetry: retryableApiError,
 * 	deadline: 5_000,
 * 	breaker: { threshold: 5, resetAfter: 30_000 },
 * });
 * ```
 */
export class Dependency {
	readonly #options: DependencyOptions;
	readonly #policy: Policy;

	/** What this dependency is called. */
	readonly name: string;

	/** The breaker for this dependency, or `undefined` if it was configured without one. */
	readonly breaker: CircuitBreaker | undefined;

	/** The bulkhead for this dependency, if it has one. */
	readonly bulkhead: Bulkhead | undefined;

	/** The rate limiter for this dependency, if it has one. */
	readonly limiter: RateLimiter | undefined;

	/** The retry budget for this dependency, if it has one. */
	readonly budget: RetryBudget | undefined;

	/**
	 * Where calls given a {@link CallOptions.share} key are collapsed. It has
	 * nothing to configure and keeps nothing once a call settles, so unlike the
	 * rest of them it is always here.
	 */
	readonly shared: SingleFlight = new SingleFlight();

	constructor(options: DependencyOptions) {
		const clock = options.clock ?? systemClock;
		const onEvent = options.onEvent;

		this.#options = options;
		this.name = options.name;

		this.breaker = options.breaker
			? new CircuitBreaker({ ...options.breaker, onEvent, clock })
			: undefined;

		this.bulkhead = options.bulkhead
			? new Bulkhead({ ...options.bulkhead, onEvent, clock })
			: undefined;

		this.limiter = options.rateLimit
			? new RateLimiter({ ...options.rateLimit, onEvent, clock })
			: undefined;

		this.budget = options.budget ? new RetryBudget(options.budget) : undefined;

		// Outermost first, and assembled here rather than described in the
		// documentation of the thing that gets it wrong.
		const policies = [
			retry({
				attempts: options.attempts,
				backoff: options.backoff,
				shouldRetry: options.shouldRetry,
				budget: this.budget,
				maxElapsed: options.maxElapsed,
				onEvent,
				clock,
			}),
			options.hedge
				? hedge({ ...options.hedge, budget: this.budget, onEvent, clock })
				: undefined,
			this.breaker?.policy,
			this.limiter?.policy,
			this.bulkhead?.policy,
			timeout(options.deadline, { onEvent, clock }),
		];

		this.#policy = stack(
			...policies.filter((policy): policy is Policy => policy !== undefined)
		);
	}

	/**
	 * Everything that applies to every call, as one policy, for a transport or
	 * a call site. What one call decided for itself is not in here; see
	 * {@link CallOptions}.
	 */
	get policy(): Policy {
		return this.#policy;
	}

	/** Runs `action` under this dependency's policy. */
	run<T>(action: Action<T>, options: CallOptions<T> = {}): Promise<T> {
		return this.wrap(action, options)(options.signal);
	}

	/**
	 * A wrapped action, for handing somewhere that expects to call it later.
	 * The signal is passed when it is called rather than here, because it
	 * belongs to the call and this can be called more than once.
	 */
	wrap<T>(
		action: Action<T>,
		options: Omit<CallOptions<T>, "signal"> = {}
	): Wrapped<T> {
		// The fallback goes outside everything, so the failure it answers for is
		// the one the caller would otherwise have caught, and the shared call
		// goes outside the retry, so joiners share the attempts too.
		const wrapped =
			options.share === undefined
				? this.#policy(action)
				: this.shared.policy(options.share)(this.#policy(action));

		return options.fallback === undefined
			? wrapped
			: fallback(options.fallback, { onEvent: this.#options.onEvent })(wrapped);
	}

	/** What this dependency is doing now. Reading it changes nothing. */
	health(): DependencyHealth {
		return {
			name: this.name,
			circuit: this.breaker?.state ?? "none",
			failures: this.breaker?.failures ?? 0,
			inFlight: this.bulkhead?.inFlight ?? 0,
			queued: this.bulkhead?.queued ?? 0,
			...(this.limiter ? { tokens: this.limiter.tokens } : {}),
			...(this.budget ? { retries: this.budget.tokens } : {}),
		};
	}

	/** The options this dependency was built from, for a health page that reports them. */
	get options(): DependencyOptions {
		return this.#options;
	}
}
