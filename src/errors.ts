/**
 * Base class for every error this package throws.
 *
 * A `FireflyError` means Firefly declined: it stopped waiting, refused to
 * start, or had nowhere to run the work. A failure that came from the work
 * itself is rethrown unchanged, so one `instanceof` separates the two.
 */
export abstract class FireflyError extends Error {
	protected constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

/**
 * An attempt passed its deadline. The attempt's signal was aborted with this
 * error as its reason; whether the work stopped is up to the work.
 */
export class TimeoutError extends FireflyError {
	override readonly name = "TimeoutError";

	/** Deadline that was exceeded, in milliseconds. */
	readonly ms: number;

	/** How long the attempt had run when it was abandoned. */
	readonly elapsed: number;

	constructor(init: { ms: number; elapsed: number }) {
		super(`Attempt exceeded its ${init.ms}ms deadline`);
		this.ms = init.ms;
		this.elapsed = init.elapsed;
	}
}

/**
 * The circuit was open, so nothing was sent.
 *
 * `cause` is the failure that opened it, which is the closest thing to an
 * explanation the breaker has.
 */
export class CircuitOpenError extends FireflyError {
	override readonly name = "CircuitOpenError";

	/** When the circuit opened. */
	readonly openedAt: number;

	/** When one trial call will be allowed through. */
	readonly retryAt: number;

	constructor(init: { openedAt: number; retryAt: number; cause?: unknown }) {
		super("Circuit is open, so no attempt was made", { cause: init.cause });
		this.openedAt = init.openedAt;
		this.retryAt = init.retryAt;
	}
}

/** Concurrency and queue were both full, so the call was refused rather than queued. */
export class BulkheadFullError extends FireflyError {
	override readonly name = "BulkheadFullError";

	/** Concurrency limit that was already reached. */
	readonly concurrency: number;

	/** Calls waiting for a slot when this one was refused. */
	readonly queued: number;

	constructor(init: { concurrency: number; queued: number }) {
		super(
			`Bulkhead is full: ${init.concurrency} in flight, ${init.queued} queued`
		);
		this.concurrency = init.concurrency;
		this.queued = init.queued;
	}
}

/** No token was available and the limiter is set to reject rather than wait. */
export class RateLimitError extends FireflyError {
	override readonly name = "RateLimitError";

	/** When the next token will be available. */
	readonly retryAt: number;

	constructor(init: { retryAt: number }) {
		super("Rate limit reached, so no attempt was made");
		this.retryAt = init.retryAt;
	}
}

/**
 * A hedged attempt was abandoned because another one answered first.
 *
 * This is the reason the losing attempts' signals are aborted with. It is not
 * reported to the caller (a hedge resolves with the winner, or rejects with
 * the last real failure), so seeing it means an action recorded its own
 * cancellation somewhere.
 */
export class HedgeAbandonedError extends FireflyError {
	override readonly name = "HedgeAbandonedError";

	/** Which attempt this was, counting from one. */
	readonly attempt: number;

	constructor(init: { attempt: number }) {
		super(`Hedged attempt ${init.attempt} was abandoned: another one answered first`);
		this.attempt = init.attempt;
	}
}
