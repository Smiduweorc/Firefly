// The `.js` extension is required: under `nodenext` resolution the specifier
// must match the emitted file, not the `.ts` source.

export { constant, exponential, fromList } from "./src/backoff.js";
export { Bulkhead } from "./src/bulkhead.js";
export { CircuitBreaker } from "./src/circuit-breaker.js";
export { systemClock } from "./src/clock.js";
export { Dependency } from "./src/dependency.js";
export {
	BulkheadFullError,
	CircuitOpenError,
	FireflyError,
	HedgeAbandonedError,
	RateLimitError,
	TimeoutError,
} from "./src/errors.js";
export { fallback } from "./src/fallback.js";
export { hedge } from "./src/hedge.js";
export { kindOf, stack, tag } from "./src/policy.js";
export { RateLimiter } from "./src/rate-limit.js";
export { retry, retryAnything } from "./src/retry.js";
export { RetryBudget } from "./src/retry-budget.js";
export { SingleFlight } from "./src/single-flight.js";
export { timeout } from "./src/timeout.js";

export type {
	Backoff,
	ExponentialOptions,
	Jitter,
	JitterOptions,
} from "./src/backoff.js";
export type {
	AdaptiveConcurrency,
	BulkheadOptions,
} from "./src/bulkhead.js";
export type {
	CircuitBreakerOptions,
	CircuitState,
	ConsecutiveBreakerOptions,
	SlidingWindow,
	WindowedBreakerOptions,
} from "./src/circuit-breaker.js";
export type { Clock } from "./src/clock.js";
export type {
	CallOptions,
	DependencyHealth,
	DependencyOptions,
} from "./src/dependency.js";
export type {
	BodyTooLargeEvent,
	BulkheadEvent,
	CircuitOpenEvent,
	EventSink,
	FireflyEvent,
	RateLimitedEvent,
	RetryEvent,
} from "./src/events.js";
export type { FallbackOptions } from "./src/fallback.js";
export type { HedgeOptions } from "./src/hedge.js";
export type {
	Action,
	Policy,
	PolicyKind,
	Stack,
	TypedPolicy,
	Wrapped,
} from "./src/policy.js";
export type { RateLimiterOptions } from "./src/rate-limit.js";
export type { RetryOptions, RetryPredicate } from "./src/retry.js";
export type { RetryBudgetOptions } from "./src/retry-budget.js";
export type { TimeoutOptions } from "./src/timeout.js";
