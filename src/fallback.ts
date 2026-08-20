import { emit, type EventSink } from "./events.js";
import type { Action, TypedPolicy, Wrapped } from "./policy.js";

/** Configuration for {@link fallback}. */
export interface FallbackOptions {
	/**
	 * Which failures deserve the substitute. Defaults to all of them, which is
	 * the honest default here: unlike a retry, answering with something is
	 * never worse for the dependency.
	 */
	readonly shouldFallback?: (error: unknown) => boolean;

	/** Receives a `fallback` event carrying the failure that was answered for. */
	readonly onEvent?: EventSink;
}

/**
 * Answers with something rather than failing, once everything else has been
 * tried: stale data, an empty list, a degraded result.
 *
 * It belongs outermost, where the failure it sees is the one the caller would
 * otherwise have caught. It is a {@link TypedPolicy} rather than a
 * {@link Policy} because it produces a result, and a result has a type, so it
 * wraps a stack rather than sitting in one:
 *
 * ```ts
 * const rates = await fallback(() => cached)(policy(readRates))();
 * ```
 *
 * The handler receives the failure, so "fall back only for this" is a decision
 * you make with the error in hand rather than one this package makes for you.
 */
export function fallback<T>(
	handler: (error: unknown) => T | Promise<T>,
	options: FallbackOptions = {}
): TypedPolicy<T> {
	return (action: Action<T>): Wrapped<T> =>
		async (signal?: AbortSignal): Promise<T> => {
			const outer = signal ?? new AbortController().signal;

			try {
				return await action(outer);
			} catch (error) {
				// The caller giving up is not a failure to answer for.
				if (outer.aborted) {
					throw error;
				}

				if (options.shouldFallback && !options.shouldFallback(error)) {
					throw error;
				}

				emit(options.onEvent, outer, { type: "fallback", error });
				return await handler(error);
			}
		};
}
