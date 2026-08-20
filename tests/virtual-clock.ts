import type { Clock } from "../index.js";

interface Timer {
	readonly at: number;
	readonly fire: () => void;
}

/** Lets the pending microtasks and continuations run before time moves again. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A clock whose time only moves when a test says so, so a five-minute backoff
 * schedule runs in the time it takes to resolve a promise.
 */
export class VirtualClock implements Clock {
	#now = 0;
	#timers = new Set<Timer>();

	now(): number {
		return this.#now;
	}

	/** Sleeps scheduled but not yet fired. */
	get pending(): number {
		return this.#timers.size;
	}

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}

		return new Promise((resolve, reject) => {
			const timer: Timer = {
				at: this.#now + ms,
				fire: () => {
					signal?.removeEventListener("abort", abort);
					resolve();
				},
			};

			const abort = (): void => {
				this.#timers.delete(timer);
				reject(signal?.reason);
			};

			this.#timers.add(timer);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	/** Moves time forward by `ms`, firing whatever falls due on the way. */
	async advance(ms: number): Promise<void> {
		const target = this.#now + ms;

		for (;;) {
			await flush();
			const next = this.#next();

			if (next === undefined || next > target) {
				break;
			}

			this.#now = Math.max(this.#now, next);
			this.#run();
		}

		this.#now = target;
		await flush();
	}

	/** Runs every sleep, however far away, until nothing is waiting on the clock. */
	async runAll(): Promise<void> {
		for (let guard = 0; guard < 1_000; guard++) {
			await flush();
			const next = this.#next();

			if (next === undefined) {
				return;
			}

			this.#now = Math.max(this.#now, next);
			this.#run();
		}

		throw new Error("the virtual clock never ran out of timers");
	}

	#next(): number | undefined {
		let next: number | undefined;

		for (const timer of this.#timers) {
			if (next === undefined || timer.at < next) {
				next = timer.at;
			}
		}

		return next;
	}

	#run(): void {
		for (const timer of [...this.#timers]) {
			if (timer.at <= this.#now) {
				this.#timers.delete(timer);
				timer.fire();
			}
		}
	}
}

/** An action that never settles on its own, and rejects when its signal aborts. */
export function pendingAction(): (signal: AbortSignal) => Promise<never> {
	return (signal) =>
		new Promise<never>((_, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
}

/** A promise a test settles by hand. */
export interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
}

/** A deferred promise, for holding an action open until a test lets it go. */
export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}
