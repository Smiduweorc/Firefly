---
title: Boundaries
---

# Boundaries

**This layer decides what to do about a failure. It does not decide what a
failure means, and it does not perform the work.**

Aphid and dung beetle hold a boundary by excluding policy. This package holds
the same boundary from the other side, by excluding everything that is not
policy. A harness that starts sending requests, reading configuration or
writing logs has taken back the decisions its consumer wrapped it to keep.

## What this layer owns

- **When to try again, and how long to wait first.** Attempt counts, backoff
  schedules, jitter, and a ceiling on both the delay and the total elapsed time.
- **How long one attempt may run.** A deadline that aborts the attempt's own
  signal rather than leaving it running behind a rejected promise.
- **When to stop trying at all.** A circuit breaker whose state is an object
  you construct, so its scope is visible where you create it.
- **How many attempts may be in flight, and how fast they may start.** A
  bulkhead and a token bucket, likewise constructed and shared by you.
- **Reporting each of those decisions.** Every retry, trip, wait and refusal is
  an event handed to a callback you supply.

## What this layer never does

| Excluded | Why | Where it goes |
| --- | --- | --- |
| Performing I/O | A harness that knows how to send a request has an opinion about the network, and pins a runtime for everyone downstream. | The action you pass in: a `fetch`, an `ApiClient` call, a database query, anything returning a promise. |
| Deciding what counts as a failure | Whether a rejection is worth repeating is domain knowledge. A 409 is fatal to one caller and expected by another, and guessing here makes the guess unremovable. | Your `shouldRetry`. `firefly-limiter/http` ships an HTTP-shaped one you opt into by importing it. |
| Replacing your errors | If the harness wrapped every failure in its own class, `error instanceof HttpError` would stop working one layer up, and the wrapper would have destroyed the reporting the layer below did carefully. | Exhausted retries rethrow the last failure unchanged. Only Firefly's own refusals are Firefly errors. |
| Logging, metrics, progress output | A library that writes to stdout has taken something that belongs to the application. | `onEvent`, which sees every decision and is called with a plain value. |
| Reading configuration from the environment | An import that reads `process.env` breaks in browsers and bundlers, and makes the package untestable without mutating globals. | The options object, where the numbers are visible at the call site. |
| Cross-process or fleet-wide state | An in-process token bucket is honest about being one process's view. A distributed limiter needs a store, a clock and a failure mode for the store itself, none of which this package can choose for you. | A store you own, behind the same interfaces. |
| Caching, freshness, `ETag` and `Vary` | A cache is storage with an invalidation story, which is the application's data layer wearing a different hat. Attaching one to a retry policy makes two unrelated lifetimes share a configuration object. | Your data layer, or a separate transport decorator. `SingleFlight` collapses concurrent calls and keeps nothing after they settle, which is the part that is not a cache. |
| Registries, singletons, patching `globalThis.fetch` | Ambient state means two libraries in one process silently share a breaker they never agreed on. | Constructing a policy and passing it where it is used. |
| Work at import time | Importing this package starts no timer, opens nothing and allocates no state, so it costs nothing in a cold start or a test harness. | A constructor call. |
| Choosing the numbers | How many attempts, how long a deadline and how wide a bulkhead are properties of your traffic and your budget. | You. There are no default attempt counts that apply when you say nothing. |

## One process

Everything Firefly holds is in-process. It is built for one to a few instances
with no service mesh: self-hosted services, small and medium projects, no
sidecar and no platform team.

With a single instance, "per process" and "fleet-wide" are the same thing, so
nothing is being approximated. Past a handful of replicas it degrades rather
than breaking: each replica still protects itself, but recovery probes and
retry budgets multiply by the replica count. At that size it complements
mesh-level controls rather than being the whole answer.

This is the boundary rather than a gap to close. A distributed limiter needs a
store, a clock all the machines agree on, and an answer for what happens when
the store itself is down, and those are choices that belong to your deployment.

### Per-host breakers

A breaker per host is composition rather than a feature. Keep a `Map` of them
and pick one with `byRequest`:

```ts
const breakers = new Map<string, CircuitBreaker>();

const forHost = (host: string): CircuitBreaker => {
 const existing = breakers.get(host);
 if (existing) {
  return existing;
 }
 const breaker = new CircuitBreaker({ threshold: 5, resetAfter: 30_000 });
 breakers.set(host, breaker);
 return breaker;
};

const retrying = retry({
 attempts: 3,
 backoff: exponential({ base: 200, max: 10_000 }),
 shouldRetry: retryableTransportError,
});

const policy = byRequest((request) =>
 stack(retrying, forHost(new URL(request.url).host).policy, timeout(2_000))
);
```

There is no evicting registry inside the package, because eviction policy is
another thing only you can choose.

## No benchmarks yet

There is no performance claim here, because there is no public harness behind
one yet. When there is, it will run on ordinary CI hardware and the numbers
will be reproducible.
