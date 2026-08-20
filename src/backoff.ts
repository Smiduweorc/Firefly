/**
 * How long to wait after the attempt numbered `attempt` failed.
 *
 * The failure is passed as well, so a schedule can read something the error
 * carries rather than only counting attempts. The schedules here ignore it,
 * and a bespoke one is a closure of your own.
 */
export type Backoff = (attempt: number, error?: unknown) => number;

/**
 * How much of the computed delay is randomised.
 *
 * `"full"` spreads the delay over `[0, delay]`, `"equal"` over
 * `[delay / 2, delay]`, and `"none"` leaves it alone. Full jitter is the
 * default everywhere because the alternative synchronises every client that
 * failed at the same moment into retrying at the same moment.
 */
export type Jitter = "full" | "equal" | "none";

/** Options shared by the schedules in this module. */
export interface JitterOptions {
	/** Defaults to `"full"`. */
	readonly jitter?: Jitter;

	/** Source of randomness, so a test can make a jittered schedule exact. Defaults to `Math.random`. */
	readonly random?: () => number;
}

/** Options for {@link exponential}. */
export interface ExponentialOptions extends JitterOptions {
	/** Delay after the first failure, before jitter. */
	readonly base: number;

	/** Multiplier applied per attempt. Defaults to `2`. */
	readonly factor?: number;

	/** Ceiling on the delay before jitter. Defaults to no ceiling. */
	readonly max?: number;
}

/** `base * factor ** (attempt - 1)`, capped at `max` and jittered. */
export function exponential(options: ExponentialOptions): Backoff {
	const factor = options.factor ?? 2;
	const max = options.max ?? Number.POSITIVE_INFINITY;

	return (attempt) =>
		applyJitter(
			Math.min(options.base * factor ** (attempt - 1), max),
			options
		);
}

/** The same delay after every failure, jittered. */
export function constant(delay: number, options: JitterOptions = {}): Backoff {
	return () => applyJitter(delay, options);
}

/**
 * The delays in `delays`, in order, repeating the last one once the list runs
 * out, so a schedule shorter than the attempt count still answers.
 */
export function fromList(
	delays: readonly number[],
	options: JitterOptions = {}
): Backoff {
	if (delays.length === 0) {
		throw new RangeError("fromList needs at least one delay");
	}

	return (attempt) =>
		applyJitter(delays[Math.min(attempt, delays.length) - 1] ?? 0, options);
}

function applyJitter(delay: number, options: JitterOptions): number {
	const random = options.random ?? Math.random;
	const jitter = options.jitter ?? "full";

	if (jitter === "none") {
		return delay;
	}

	if (jitter === "equal") {
		return delay / 2 + random() * (delay / 2);
	}

	return random() * delay;
}
