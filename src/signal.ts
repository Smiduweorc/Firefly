/**
 * An attempt's own signal, linked to the caller's.
 *
 * Every policy that can abandon an attempt needs a signal that aborts when the
 * caller aborts *or* when the policy decides to give up. `AbortSignal.any`
 * says exactly that in one line, and costs about ten times as much as the
 * whole policy around it: the composite is registered with a
 * `FinalizationRegistry`, so each call leaves a couple of kilobytes that only
 * come back on a turn of the event loop. Forwarding the caller's abort into a
 * controller of our own is the same guarantee for a tenth of the cost and
 * nothing left behind.
 *
 * The link is one-way and lasts as long as the attempt: {@link Derived.release}
 * detaches it when the attempt settles, so a signal that outlives the calls
 * made under it — a shutdown signal handed to everything — does not collect a
 * listener per call. The attempt's signal stops following the caller at that
 * point, which is the whole of the difference: an abort that arrives after the
 * call has already answered is the caller's own business.
 */
export interface Derived {
	/** The attempt's signal, to hand to the action. */
	readonly signal: AbortSignal;

	/** Abandons the attempt, leaving the caller's signal alone. */
	abort(reason?: unknown): void;

	/** Detaches from the caller's signal. Call it when the attempt settles. */
	release(): void;
}

/** A signal that aborts when `parent` does, and that the policy can abort itself. */
export function derive(parent: AbortSignal): Derived {
	const controller = new AbortController();

	if (parent.aborted) {
		controller.abort(parent.reason);

		return {
			signal: controller.signal,
			abort: (reason?: unknown): void => controller.abort(reason),
			release: (): void => {},
		};
	}

	const forward = (): void => controller.abort(parent.reason);

	parent.addEventListener("abort", forward, { once: true });

	return {
		signal: controller.signal,
		abort: (reason?: unknown): void => controller.abort(reason),
		release: (): void => parent.removeEventListener("abort", forward),
	};
}

/**
 * The reason an internal timer is abandoned with.
 *
 * `abort()` with no reason builds a `DOMException`, and building one captures
 * a stack trace: about five microseconds, on a path that runs on every call
 * and produces a rejection nobody outside this package ever sees. Passing a
 * reason of our own is the same cancellation for a tenth of the cost.
 */
export const cancelled = Symbol("firefly: timer cancelled");
