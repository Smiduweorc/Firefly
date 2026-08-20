---
title: HTTP
---

# HTTP

`firefly-limiter/http` is a separate entry point. Nothing in the core
surface imports it, so a consumer with no HTTP in sight pulls in no HTTP.

```ts
import { transport, retryableTransportError } from "firefly-limiter/http";

const api = new ApiClient({
 baseUrl: "https://api.acme.com/v1",
 transport: transport(fetch, payments.policy),
});
```

`transport` wraps a `fetch`-shaped function in a policy and hands back a
function of the same shape:

```ts
type Transport = (request: Request) => Promise<Response>;
```

That is character for character the type Aphid and dung beetle export for their
transports, declared here rather than imported, so neither package has to be
installed for the two to fit together.

## The one thing to know

**A transport runs below the client's error classes.** `ApiClient` turns a
non-2xx response into an `HttpError` *after* the transport returns, so a
decorator never sees one. A 429 arrives here as an ordinary resolved
`Response`.

So `transport` reads the response itself. It raises a `RetryableResponseError`
for the statuses worth repeating, which is what the policies above it see as a
failure, and hands the final response back untouched with its body unread, so
`decode` and `HttpError.body` behave as they do with no policy in the way.

This is also why the `shouldRetry` for a policy handed to `transport` is
`retryableTransportError` rather than a predicate of your own:

```ts
retry({
 attempts: 3,
 backoff: exponential({ base: 200, max: 10_000 }),
 shouldRetry: retryableTransportError,
});
```

It repeats a `RetryableResponseError` and a `TimeoutError`, declines every
other `FireflyError`, and declines the caller's own abort. An open circuit and
a full bulkhead are refusals rather than failures, and repeating them only
spends attempts on a call that was never made.

## What it decides

### Status classification

`408`, `425`, `429`, `500`, `502`, `503` and `504` are retried by default. The
set is the exported `retryableStatuses`, and `retryStatuses` replaces it.

A response that is about to be discarded has its body cancelled, so a retried
call leaks nothing.

### `Retry-After`

Honoured for `429` and `503`, in both forms the specification allows:
delta-seconds and an HTTP-date. A missing, malformed or already-past value is
ignored, because a header nobody can parse should not become a wait nobody
asked for. `parseRetryAfter` is exported if you want it directly.

The wait is **absorbed into the next attempt rather than added to it**, so a
backoff longer than the header does not wait twice.

`maxRetryAfter` caps it, and defaults to 30 seconds. Set it to the same figure
as your schedule's `max`. Without a ceiling, a mistaken or hostile header can
park a request for an hour.

### Idempotency

`GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` are retried. `POST` and `PATCH`
are not, unless the request carries an `Idempotency-Key` header or you pass
`retryUnsafeMethods: true`.

Whether repeating one is safe is the question the transport cannot answer. It
can see the method and the header, and you know the rest.

### Body replay

Replaying a body means keeping it, and a stream gives no way to ask how long it
is. So a body is read up to `maxReplayBytes`, which defaults to one mebibyte:

- **Under the ceiling**, every attempt is sent from the same bytes.
- **Over it**, the request is sent once, whole, and never repeated.

An upload cannot quietly become the process's memory problem, and it cannot be
truncated either. Either way a `body-too-large` event is emitted, because this
is the only thing here that quietly changes whether a request can be repeated.

A request that declares its own length is not read at all when the declaration
is already over the ceiling. `bodySize` supplies that length; it defaults to
reading `content-length`, which survives on a `Request` under Node but is a
forbidden header in a browser. It is a hint rather than an answer: a body that
declares nothing is still read against the ceiling, and one that declares a lie
is still measured. What the hint buys is not reading two gigabytes to discover
that two gigabytes is too much.

### Cancellation

The caller's signal, which a client puts on the `Request`, is what the policy
runs under. Per-attempt deadlines derive their own signals from it, and an
abort by the caller is not retried.

## Different policies for different endpoints

A transport applies to every call, which is right for a breaker and wrong for a
payment endpoint that needs longer than a search box:

```ts
import { byRequest } from "firefly-limiter/http";

const api = new ApiClient({
 baseUrl: "https://api.acme.com/v1",
 transport: transport(
  fetch,
  byRequest((request) =>
   request.url.includes("/payments") ? payments.policy : reads.policy
  )
 ),
});
```

Build the policies once, outside the selector, so the state inside them is
shared as deliberately as anything else. A breaker rebuilt per request measures
nothing.

## Working with Aphid and dung beetle

Both templates end their boundary section the same way: the excluded behaviour
goes in a decorator around `ApiClient`'s transport. `firefly-limiter/http` is that
decorator, written out.

The dependency that matters runs in the other direction, and it should not
exist:

- **A client you publish from Aphid or dung beetle must not depend on Firefly.**
  Baking a retry policy into `@acme/api-client` gives every consumer of that
  package your timeouts and your attempt counts, and takes away the seam the
  template preserved.
- **The application depends on Firefly**, and hands the transport in.

A generated client is no different. dung beetle's generator writes resource
modules and never writes policy, so a regenerated client's diff stays free of
it.

### What a refusal looks like from above

A Firefly refusal reaches the caller through the template's own error mapping.
The transport rejects, so `ApiClient` reports a `TransportError`, and Firefly's
error is its cause:

```ts
try {
 await api.request(listInvoices());
} catch (error) {
 if (error instanceof TransportError && error.cause instanceof TimeoutError) {
  // the deadline, not the network
 }
 if (error instanceof TransportError && error.cause instanceof CircuitOpenError) {
  // nothing was sent; error.cause.retryAt says when one call will be tried
 }
 if (error instanceof HttpError) {
  // a status the policy did not retry, or retried until it ran out
 }
 throw error;
}
```

This is why exhausted retries rethrow rather than wrap. The `HttpError` a
caller catches is the one the API actually produced, carrying the API's own
body, whether or not a policy tried three times to avoid it.

## Above the client instead

The other attachment point is around `api.request(...)`, where the typed result
and the error classes are both in scope. It suits a per-call-site fallback, and
it is the wrong place for a breaker, because a breaker that only some call
sites go through is not measuring the dependency.

`retryableApiError` is the predicate for that position. It recognises the
templates' errors structurally, by name and shape, so nothing depends on Aphid
or dung beetle being installed: a `TransportError` is retryable unless the
caller aborted it, an `HttpError` is retryable when its status is in the set,
and a `DecodeError` never is, because sending the request again will not make
the body parse.
