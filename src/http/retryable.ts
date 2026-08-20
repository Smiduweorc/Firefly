import { FireflyError, TimeoutError } from "../errors.js";

/**
 * Statuses `transport` turns into a rejection when it is not given a set of
 * its own: the ones a server uses to say "not now" rather than "no".
 */
export const retryableStatuses: readonly number[] = [
	408, 425, 429, 500, 502, 503, 504,
];

/** Methods whose semantics allow the same request to be sent twice. */
export const idempotentMethods: readonly string[] = [
	"GET",
	"HEAD",
	"OPTIONS",
	"PUT",
	"DELETE",
];

/**
 * A response the transport is going to try again, raised so the policies above
 * it see a failure instead of a resolved `Response`.
 *
 * It never reaches the caller: whichever attempt is the last one, the
 * transport returns the response it carries, body unread. It is exported for
 * the policies in between: a `shouldRetry` or an `isFailure` that wants to
 * treat a 503 differently from a connection reset.
 */
export class RetryableResponseError extends Error {
	override readonly name = "RetryableResponseError";

	/** The response, with its body still unread. */
	readonly response: Response;

	/** Status that made it retryable. */
	readonly status: number;

	constructor(response: Response) {
		super(`HTTP ${response.status} is retryable`);
		this.response = response;
		this.status = response.status;
	}
}

/**
 * Whether a failure seen *inside* a transport is worth repeating: the
 * classification `transport` already did, plus a deadline, minus Firefly's own
 * refusals and the caller's own abort.
 *
 * This is the `shouldRetry` for a policy handed to {@link transport}. An open
 * circuit and a full bulkhead are refusals rather than failures, and repeating
 * them only spends attempts on a call that was never made.
 */
export function retryableTransportError(error: unknown): boolean {
	if (error instanceof RetryableResponseError) {
		return true;
	}

	if (error instanceof TimeoutError) {
		return true;
	}

	if (error instanceof FireflyError) {
		return false;
	}

	return error instanceof Error && !isAbort(error) && !isAbort(error.cause);
}

/**
 * Whether an error thrown by an `ApiClient` call is worth repeating, for a
 * policy wrapped around the client rather than around the transport.
 *
 * The templates' errors are recognised structurally, by name and shape, so
 * nothing here depends on Aphid or dung beetle being installed: a
 * `TransportError` is retryable unless the caller aborted it, an `HttpError`
 * is retryable when its status is in `statuses`, and a `DecodeError` never is,
 * because sending the request again will not make the body parse.
 */
export function retryableApiError(
	error: unknown,
	statuses: readonly number[] = retryableStatuses
): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	if (error.name === "TransportError") {
		return !isAbort(error.cause);
	}

	if (error.name === "HttpError") {
		const { status } = error as { status?: unknown };
		return typeof status === "number" && statuses.includes(status);
	}

	return false;
}

function isAbort(cause: unknown): boolean {
	return cause instanceof Error && cause.name === "AbortError";
}
