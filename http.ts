// The "@smiduweorc/firefly/http" entry point. Nothing in the core surface
// imports it, so a consumer with no HTTP in sight pulls in no HTTP.

export { byRequest } from "./src/http/by-request.js";
export { parseRetryAfter } from "./src/http/retry-after.js";
export {
	idempotentMethods,
	RetryableResponseError,
	retryableApiError,
	retryableStatuses,
	retryableTransportError,
} from "./src/http/retryable.js";
export { transport } from "./src/http/transport.js";

export type { ByRequest } from "./src/http/by-request.js";
export type { Transport, TransportOptions } from "./src/http/transport.js";
