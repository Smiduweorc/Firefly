/** Configuration for a {@link RetryBudget}. */
export interface RetryBudgetOptions {
	/**
	 * Retries allowed per call, as a share: `0.2` lets the client retry a fifth
	 * of what it sends. Every call earns this much, spent one token per retry.
	 */
	readonly ratio: number;

	/**
	 * Largest run of retries allowed when nothing has been earned yet, and the
	 * ceiling the earnings are capped at. The budget starts full, so a quiet
	 * client can still retry.
	 */
	readonly capacity: number;
}

/**
 * A ceiling on retries across every call that shares it, so a dependency that
 * is failing does not get several times its usual traffic.
 *
 * `attempts: 3` bounds one call. It cannot see that every other caller is also
 * on its third attempt, which is how a struggling dependency ends up with
 * three times the load at the moment it can least take it. A budget is the
 * part that sees the total, so it is an object you construct and share, like a
 * breaker.
 *
 * It counts rather than measures time: no clock, no timer, nothing to drift.
 */
export class RetryBudget {
	readonly #options: RetryBudgetOptions;

	#tokens: number;

	constructor(options: RetryBudgetOptions) {
		this.#options = options;
		this.#tokens = options.capacity;
	}

	/** Retries available now. */
	get tokens(): number {
		return this.#tokens;
	}

	/** Records that a call started, which is what earns the budget back. */
	record(): void {
		this.#tokens = Math.min(
			this.#options.capacity,
			this.#tokens + this.#options.ratio
		);
	}

	/** Spends one retry if there is one to spend. */
	tryTake(): boolean {
		if (this.#tokens < 1) {
			return false;
		}

		this.#tokens--;
		return true;
	}
}
