/** A unit of work that can be attempted. The signal aborts when the policy abandons the attempt. */
export type Action<T> = (signal: AbortSignal) => Promise<T>;

/**
 * An action a policy has wrapped.
 *
 * It is an {@link Action}, which is what lets policies nest, but its signal is
 * optional: the outermost call has no policy above it to supply one, and an
 * action always receives a real signal from the policy that calls it.
 */
export type Wrapped<T> = (signal?: AbortSignal) => Promise<T>;

/** One behaviour, wrapping an action into an action. */
export type Policy = <T>(action: Action<T>) => Wrapped<T>;

/**
 * A policy that only works for one result type, because it produces a result
 * of its own. {@link fallback} is the only one here.
 *
 * It cannot go in a {@link stack}, which is a list of policies that work for
 * every type; it wraps the stack instead.
 */
export type TypedPolicy<T> = (action: Action<T>) => Wrapped<T>;

/** What a policy does, which is what {@link stack} checks the order against. */
export type PolicyKind =
	| "fallback"
	| "single-flight"
	| "retry"
	| "hedge"
	| "circuit-breaker"
	| "rate-limiter"
	| "bulkhead"
	| "timeout";

// Registered globally so the check still works when two copies of the package
// end up in one process, which is exactly when the mistake is hardest to see.
const kindKey = Symbol.for("smiduweorc.firefly.policy.kind");

type Labelled = { [key: symbol]: PolicyKind | undefined };

// Outermost first. Two policies of the same kind may sit next to each other.
const order: readonly PolicyKind[] = [
	"fallback",
	"single-flight",
	"retry",
	"hedge",
	"circuit-breaker",
	"rate-limiter",
	"bulkhead",
	"timeout",
];

const places: Record<PolicyKind, string> = {
	fallback: "outermost, where it can answer for a call that failed all the way through",
	"single-flight": "outside the retry, so callers sharing a key share its attempts too",
	retry: "outside the breaker, so every attempt is recorded rather than one outage counting once",
	hedge: "inside the retry and outside the breaker, so each branch is recorded on its own",
	"circuit-breaker":
		"inside the retry and outside the waiting policies, so an open circuit refuses instead of queueing for a slot it will not use",
	"rate-limiter": "outside the bulkhead, so waiting for a token does not hold a concurrency slot",
	bulkhead: "directly around the work, where the count of in-flight attempts is the thing being bounded",
	timeout: "innermost, because it is a deadline per attempt and not a budget for the operation",
};

/**
 * Records what a policy does, so {@link stack} can refuse an arrangement that
 * cannot work.
 *
 * Every policy in this package is labelled already. Label your own when you
 * want it held to the same order; leave it unlabelled and `stack` will pass it
 * through without an opinion.
 */
export function tag(policy: Policy, kind: PolicyKind): Policy {
	Object.defineProperty(policy, kindKey, { value: kind });
	return policy;
}

/** What a policy was labelled as, or `undefined` for one that never was. */
export function kindOf(policy: Policy): PolicyKind | undefined {
	return (policy as unknown as Labelled)[kindKey];
}

/** Composes policies left to right, outermost first. */
export interface Stack {
	(...policies: Policy[]): Policy;

	/**
	 * The same composition with the ordering check removed, for the
	 * arrangement you mean and this package does not know about.
	 */
	readonly unchecked: (...policies: Policy[]) => Policy;
}

/**
 * Composes policies left to right, outermost first, so the argument order
 * reads the way the stack is drawn: the first policy sees the call before the
 * second, and the last one is closest to the work.
 *
 * `stack(a, b)(action)` is `a(b(action))`.
 *
 * An order that cannot work is a mistake this package can see, so it throws
 * here rather than describing the right order in its documentation and hoping.
 * Only labelled policies are checked; see {@link tag} and
 * {@link Stack.unchecked}.
 *
 * @throws {TypeError} If a labelled policy sits outside one that must contain it.
 */
export const stack: Stack = Object.assign(
	(...policies: Policy[]): Policy => {
		check(policies);
		return compose(policies);
	},
	{
		unchecked: (...policies: Policy[]): Policy => compose(policies),
	}
);

function compose(policies: Policy[]): Policy {
	return <T>(action: Action<T>): Wrapped<T> => {
		const composed = policies.reduceRight<Action<T>>(
			(inner, policy) => policy(inner),
			action
		);

		return (signal) => composed(signal ?? new AbortController().signal);
	};
}

function check(policies: Policy[]): void {
	const labelled = policies
		.map((policy) => kindOf(policy))
		.filter((kind): kind is PolicyKind => kind !== undefined);

	for (let i = 1; i < labelled.length; i++) {
		const outer = labelled[i - 1] as PolicyKind;
		const inner = labelled[i] as PolicyKind;

		if (order.indexOf(outer) > order.indexOf(inner)) {
			throw new TypeError(
				`${outer} was placed outside ${inner}. A ${outer} belongs ${places[outer]}. ` +
					"Reorder the stack, or use stack.unchecked if this arrangement is deliberate."
			);
		}
	}
}
