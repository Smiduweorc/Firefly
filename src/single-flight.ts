import { tag, type Action, type Policy, type Wrapped } from "./policy.js";

interface Call<T> {
	readonly controller: AbortController;
	readonly promise: Promise<T>;
	joiners: number;
}

/**
 * Collapses concurrent calls that share a key into one call.
 *
 * It stores nothing once a call settles: the next caller starts a new one.
 * That is the whole difference between this and a cache, and it is why there
 * is no expiry to configure. A cache is storage with an invalidation story,
 * which belongs in your data layer.
 *
 * The shared call is abandoned only when every caller has abandoned it: each
 * caller's signal detaches that caller, and the last one to leave aborts the
 * work.
 */
export class SingleFlight<K = string> {
	readonly #calls = new Map<K, Call<unknown>>();

	/** Keys with a call in flight. */
	get inFlight(): number {
		return this.#calls.size;
	}

	/** Whether a call is in flight under `key`. */
	has(key: K): boolean {
		return this.#calls.has(key);
	}

	/** Runs `action` under `key`, or joins the call already running under it. */
	run<T>(key: K, action: Action<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}

		const existing = this.#calls.get(key) as Call<T> | undefined;
		const call = existing ?? this.#start(key, action);

		call.joiners++;

		if (!signal) {
			return call.promise;
		}

		return new Promise<T>((resolve, reject) => {
			const leave = (): void => {
				call.joiners--;

				if (call.joiners === 0) {
					call.controller.abort(signal.reason);
				}

				reject(signal.reason);
			};

			signal.addEventListener("abort", leave, { once: true });

			call.promise.then(
				(value) => {
					signal.removeEventListener("abort", leave);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", leave);
					reject(error);
				}
			);
		});
	}

	/** A policy that runs everything it wraps under one key. */
	policy(key: K): Policy {
		return tag(
			<T>(action: Action<T>): Wrapped<T> =>
				(signal?: AbortSignal): Promise<T> => this.run(key, action, signal),
			"single-flight"
		);
	}

	#start<T>(key: K, action: Action<T>): Call<T> {
		const controller = new AbortController();

		const call: Call<T> = {
			controller,
			joiners: 0,
			promise: (async () => {
				try {
					return await action(controller.signal);
				} finally {
					this.#calls.delete(key);
				}
			})(),
		};

		// Callers that leave early take their handlers with them, and the last
		// one to leave has already aborted the work; the rejection it produces
		// still needs an owner.
		call.promise.catch(() => undefined);

		this.#calls.set(key, call as Call<unknown>);
		return call;
	}
}
