import type { Policy } from "../policy.js";

/** A policy chosen per request, which `transport` accepts wherever it accepts a policy. */
export interface ByRequest {
	/** Picks the policy for one request. */
	readonly forRequest: (request: Request) => Policy;
}

/**
 * Picks a policy from the request, for the parts of an API that do not deserve
 * the same deadline as the rest of it.
 *
 * A transport applies to every call, which is right for a breaker (one that
 * only some call sites go through is not measuring the dependency) and wrong
 * for a payment endpoint that needs longer than a search box. Build the
 * policies once, outside the selector, so the state inside them is shared as
 * deliberately as anything else.
 */
export function byRequest(select: (request: Request) => Policy): ByRequest {
	return { forRequest: select };
}
