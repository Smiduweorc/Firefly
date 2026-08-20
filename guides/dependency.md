---
title: Dependency
---

# Dependency

`Dependency` is one upstream and everything you have decided about calling it.
It is the front door, and for most services it is the only thing you need to
construct.

It exists because a policy stack assembled per call site puts the state in the
wrong place. A breaker built inside a client factory is a breaker per client,
and a breaker that only some call sites go through is not measuring the
dependency. Here the state and the scope are the same object: one per upstream,
constructed where you can see it, shared by everything that talks to it.

```ts
import { Dependency, exponential, retryAnything } from "firefly-js";

export const payments = new Dependency({
	name: "payments",
	attempts: 3,
	backoff: exponential({ base: 200, max: 10_000 }),
	shouldRetry: retryAnything,
	deadline: 5_000,
	breaker: { threshold: 5, resetAfter: 30_000 },
});
```

## What it assembles

The numbers are yours. The order is not, so it is assembled here where it
cannot be got wrong:

```
retry -> hedge? -> breaker? -> limiter? -> bulkhead? -> timeout
```

Anything you did not configure is left out of the stack rather than included
with a default. `onEvent` and `clock` are passed down to every piece, so you
set them once.

Two policies sit outside all of that and are decided per call, because they
cannot be decided per dependency: `share` needs something to share on, and
`fallback` produces a result whose type belongs to one call.

## Required options

Every one of these is a decision only you can make, so none has a default.

| Option | What it is |
| --- | --- |
| `name` | What this dependency is called, in `health()` output and your own logs. |
| `attempts` | Total attempts per call, not additional ones. `1` never retries. |
| `backoff` | How long to wait between attempts. See [Policies](./policies.md). |
| `shouldRetry` | Whether a failure is worth repeating. |
| `deadline` | Deadline for one attempt, in milliseconds. |
| `breaker` | When to stop calling this dependency, or `false`. |

`breaker: false` is not the same as leaving the field out, because the field
cannot be left out. It says you decided against a breaker rather than forgot
one.

`shouldRetry` has no default either. Whether a rejection is worth repeating is
the one thing this package cannot know: a 409 is fatal to one caller and
expected by another. `retryAnything` is how you say "repeat everything" and
mean it. Under a `firefly-js/http` transport, use `retryableTransportError`, which
already classified the response.

## Optional options

| Option | Add it when |
| --- | --- |
| `bulkhead` | One slow upstream must not consume every socket or worker. |
| `rateLimit` | The API publishes a rate limit, or you are being polite. |
| `budget` | Retries must not multiply an outage across concurrent callers. |
| `hedge` | The p99 is the problem rather than the failures. |
| `maxElapsed` | A whole call, across all its attempts, has a time budget. |
| `onEvent` | You want the decisions in your metrics or logs. |
| `clock` | You are testing, or you keep time yourself. |

`budget` is shared by the retries and the hedged attempts, so the two cannot
quietly add up to several times the load. Each option's own fields are
documented on its policy in [Policies](./policies.md); the `onEvent` and
`clock` fields are omitted from them here because the dependency supplies both.

## Calling through it

`run` takes the action and returns the result:

```ts
const invoice = await payments.run((signal) => charge(id, signal));
```

`wrap` returns the wrapped action instead, for handing somewhere that will call
it later. The signal is passed at call time rather than at wrap time, because
it belongs to the call and a wrapped action can be called more than once:

```ts
const charge = payments.wrap((signal) => post(id, signal));
queue.push(charge);
```

### Per-call options

```ts
const today = await rates.run(readRates, {
	share: "today",
	fallback: () => cached,
	signal: request.signal,
});
```

`share` collapses this call into any other call to the same dependency running
under the same key, so twenty callers wanting one thing make one request and
share its attempts. Nothing is kept once the call settles, so the caller after
them starts a new one.

`fallback` answers with something rather than failing: stale data, an empty
list, a degraded result. It goes outside everything, so it sees Firefly's own
refusals too, and an open circuit becomes stale data instead of an exception.
The handler receives the failure, and throwing from it declines to answer for
that one.

`signal` abandons this call.

## Reading state

`health()` reports what the dependency is doing, in a shape a health endpoint
can return. Reading it changes nothing:

```ts
app.get("/health", () => payments.health());
```

```ts
{
	name: "payments",
	circuit: "closed",  // or "open", "half-open", or "none" if breaker: false
	failures: 0,        // what the breaker is currently counting
	inFlight: 0,
	queued: 0,
	tokens: 10,         // only when there is a rate limiter
	retries: 10,        // only when there is a retry budget
}
```

The pieces themselves are readable as well, for anything `health()` does not
cover: `payments.breaker`, `.bulkhead`, `.limiter`, `.budget` (each `undefined`
when not configured), `.shared` for the single-flight, and `.options` for the
options it was built from. `.policy` is everything that applies to every call,
as one policy, which is what you hand to a transport.

## When to drop to `stack`

`Dependency` is one stack in one order. Reach past it when you need a different
arrangement, when two dependencies must share a breaker, or when the work is
not shaped like a service call. Nothing is lost by doing so: `Dependency` is
built out of the same public pieces, and `stack` still checks the order.
