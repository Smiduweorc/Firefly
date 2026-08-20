/**
 * The two things a policy needs from time.
 *
 * Every policy reads the clock through this interface and none of them call
 * `Date.now` or `setTimeout` directly, so a test can run a five-minute backoff
 * schedule without waiting five minutes.
 */
export interface Clock {
	/** Current time in milliseconds. Only differences between readings are used. */
	now(): number;

	/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** `Date.now` and `setTimeout`, used by any policy that is not given a clock. */
export const systemClock: Clock = {
	now(): number {
		return Date.now();
	},

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}

		return new Promise((resolve, reject) => {
			const abort = (): void => {
				clearTimeout(timer);
				reject(signal?.reason);
			};

			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", abort);
				resolve();
			}, ms);

			signal?.addEventListener("abort", abort, { once: true });
		});
	},
};
