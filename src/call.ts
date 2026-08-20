/**
 * What one call knows about itself, threaded from policy to policy.
 *
 * The signal is the only value that already travels the whole way down a
 * stack, so the record rides on it rather than in a context parameter added to
 * {@link Action}. That keeps the type of a policy exactly what it was, and
 * means a hand-written policy that passes its signal through inherits all of
 * this for free.
 */
interface Call {
	/** Identifies every event from this call. */
	readonly id: string;

	/** When the operation's whole budget runs out, if it has one. */
	deadline?: number;
}

const calls = new WeakMap<AbortSignal, Call>();

let sequence = 0;

function record(signal: AbortSignal): Call {
	let call = calls.get(signal);

	if (!call) {
		call = { id: String(++sequence) };
		calls.set(signal, call);
	}

	return call;
}

/** The id every event from one call carries, assigned on first use. */
export function callId(signal: AbortSignal): string {
	return record(signal).id;
}

/** Gives a derived signal the same identity as the one it came from. */
export function inherit(from: AbortSignal, to: AbortSignal): void {
	calls.set(to, record(from));
}

/** Marks when this call's whole budget runs out, so a deadline below can respect it. */
export function budgetUntil(signal: AbortSignal, at: number): void {
	record(signal).deadline = at;
}

/** What is left of the operation's budget, or `undefined` when it has none. */
export function remaining(signal: AbortSignal, now: number): number | undefined {
	const deadline = calls.get(signal)?.deadline;
	return deadline === undefined ? undefined : deadline - now;
}
