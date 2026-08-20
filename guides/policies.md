---
title: Policies
---

# Policies

Each policy on its own: what it does, the numbers that matter, and the shape of
the thing you construct. All of them compose with [`stack`](./concepts.md), and
most of them are also assembled for you by
[`Dependency`](./dependency.md).

Policies that hold state (`CircuitBreaker`, `Bulkhead`, `RateLimiter`,
`RetryBudget`, `SingleFlight`) are objects you construct, so their scope is
whatever you share them with. The rest (`retry`, `timeout`, `hedge`,
`fallback`) are functions that return a policy.

## Backoff schedules

A schedule is a function from an attempt number to a delay, so a bespoke one is
a closure of your own:

```ts
type Backoff = (attempt: number, error?: unknown) => number;
```

The failure is passed as well, so a schedule can read something the error
carries rather than only counting attempts. The three provided schedules ignore
it.

```ts
exponential({ base: 200, factor: 2, max: 10_000 })  // base * factor ** (attempt - 1)
constant(500)                                        // the same delay every time
fromList([100, 500, 2_000])                          // in order, repeating the last
```

`factor` defaults to `2` and `max` to no ceiling. `fromList` repeats its last
delay once the list runs out, so a schedule shorter than the attempt count
still answers, and it throws a `RangeError` if the list is empty.

### Jitter

Every schedule is jittered, and **full jitter is the default**, because the
alternative synchronises every client that failed at the same moment into
retrying at the same moment.

| `jitter` | Spreads the delay over |
| --- | --- |
| `"full"` (default) | `[0, delay]` |
| `"equal"` | `[delay / 2, delay]` |
| `"none"` | nothing; the delay is exact |

Pass `random` to make a jittered schedule exact in a test.

## `retry`

Repeats the action until it succeeds, the options say to stop, or the caller's
signal aborts.

```ts
retry({
	attempts: 3,
	backoff: exponential({ base: 100, max: 5_000 }),
	shouldRetry: (error, attempt) => isTransient(error),
	budget: shared,
	maxElapsed: 20_000,
});
```

| Option | Notes |
| --- | --- |
| `attempts` | Total, not additional. `1` never retries. |
| `backoff` | Required. |
| `shouldRetry` | Required, called with the error and the attempt that produced it. |
| `budget` | A `RetryBudget` shared with other callers. |
| `maxElapsed` | No attempt is started once the wait before it would carry the call past this, measured from the first attempt. |

`shouldRetry` has no default on purpose. `retryAnything` is the explicit way to
repeat everything; import it where you mean it, because passing it for want of
anything else means retrying a `TypeError` in your own code three times,
slowly.

Besides success, the loop ends when the caller's signal aborts, when the
attempts run out, when `shouldRetry` returns false, when a shared budget has no
token left, or when the next backoff would carry the call past `maxElapsed`. In
every one of those cases the last failure is rethrown exactly as it was, and a
caller's abort propagates rather than being repeated.

## `RetryBudget`

A ceiling on retries across every call that shares it.

`attempts: 3` bounds one call. It cannot see that every other caller is also on
its third attempt, which is how a struggling dependency ends up with three
times the load at the moment it can least take it. A budget is the part that
sees the total.

```ts
const budget = new RetryBudget({ ratio: 0.2, capacity: 10 });
```

`ratio` is retries earned per call: `0.2` lets the client retry a fifth of what
it sends. `capacity` is both the ceiling on what can be saved up and the
largest run of retries allowed when nothing has been earned yet. It starts
full, so a quiet client can still retry.

It counts rather than measures time: no clock, no timer, nothing to drift. Read
`budget.tokens` for what is left. When it runs out, a `budget-exhausted` event
is emitted and the failure is rethrown.

## `timeout`

Gives each attempt `ms` to finish, aborting that attempt's own signal with a
`TimeoutError` and rejecting with the same error.

```ts
timeout(2_000)
```

The abort is the point. An action that watches its signal stops working rather
than running on behind a promise nobody is waiting for.

This is a deadline per attempt. For a budget across all attempts, use
`maxElapsed` on `retry`. An attempt never outlives that budget: a deadline that
would run past it is cut short.

## `CircuitBreaker`

Stops calling a dependency that is failing, and tries one call once the reset
window has passed.

There are two trip conditions and you pick one.

**Consecutive failures**, which is the simple one:

```ts
const breaker = new CircuitBreaker({
	threshold: 5,
	resetAfter: 30_000,
});
```

**A rate over a window**, which is the right one above a certain volume,
because 40% of calls failing interleaved with successes never reaches five in a
row:

```ts
const breaker = new CircuitBreaker({
	resetAfter: 30_000,
	window: {
		size: 100,
		within: 60_000,
		minimumCalls: 20,
		failureRate: 0.5,
		slowerThan: 2_000,
		slowRate: 0.3,
	},
});
```

| Window field | What it is |
| --- | --- |
| `size` | Calls remembered. |
| `within` | How recent a call must be to count. Without it, the window is the last `size` calls however long ago, which reads a quiet service's morning as if it were now. |
| `minimumCalls` | Calls required before a rate can open the circuit, so two failures at three in the morning do not read as 100%. |
| `failureRate` | Share of the window that must have failed, `0` to `1`. |
| `slowerThan` | Calls at least this slow count as slow, whether or not they succeeded. |
| `slowRate` | Share of the window that must be slow. |

A dependency answering every call in nine seconds is down; it just has not
admitted it. That is what `slowRate` is for. A circuit opened by slowness alone
has no failure to report, so its `CircuitOpenError.cause` is `undefined`.

Both forms take `isFailure`, which decides whether an error counts. An error it
declines is not recorded at all: it neither opens nor closes the circuit, and
passes through untouched.

`probes` (default `1`) is how many calls are let through while half-open, and
how many must succeed to close it. More than one closes a recovered dependency
faster, and every probe is another call to something that was failing a moment
ago.

Read `breaker.state` (`"closed"`, `"open"`, `"half-open"`), `breaker.failures`
and `breaker.recorded`. Reading changes nothing. Constructing one starts no
timer.

## `Bulkhead`

Bounds how many calls may be in flight at once, and how many may wait. It is
what keeps one slow dependency from consuming every connection, socket or
worker the process has.

```ts
const bulkhead = new Bulkhead({
	concurrency: 20,
	queue: 100,
	queueTimeout: 1_000,
});
```

`queue` defaults to `0`, which refuses instead of queueing, with a
`BulkheadFullError`. `queueTimeout` bounds the wait: a call that will time out
anyway should be refused now, while the caller can still do something else.

The queue is served in order. A slot is handed to whoever has waited longest
rather than to whoever asks next, and waiting ends early if the caller's signal
aborts.

### Adaptive concurrency

`adapt` moves the limit with what the dependency is actually managing rather
than with the number you guessed: additive increase while calls succeed under
pressure, multiplicative decrease when they fail or drag.

```ts
adapt: { min: 5, max: 100, slowerThan: 1_000, decrease: 0.9 }
```

`decrease` defaults to `0.9`. The limit only grows while it is the thing
holding calls back, because widening a bulkhead nothing is queueing for
measures nothing. Read the current value from `bulkhead.concurrency`, alongside
`inFlight` and `queued`.

## `RateLimiter`

A token bucket, in this process and no other.

```ts
const limiter = new RateLimiter({
	capacity: 10,
	perSecond: 5,
	onExhausted: "wait",
});
```

`capacity` is the bucket size, which is the largest burst allowed after an idle
period. `onExhausted` defaults to `"wait"`; `"reject"` refuses with a
`RateLimitError` carrying `retryAt` instead.

It refills against the clock rather than on a timer, so it costs nothing while
idle and cannot drift. Callers that wait are served in the order they arrived,
so a steady stream of new calls cannot starve the one that has waited longest.
Read `limiter.tokens` and `limiter.queued`, or spend a token directly with
`await limiter.take(signal)`.

## `hedge`

Sends the same work again before the first attempt has failed, and takes the
first answer.

A retry waits for a failure, and a slow call is not a failure. Waiting for one
is how a p99 becomes a timeout.

```ts
hedge({
	attempts: 2,
	delay: 300,
	budget: shared,
});
```

`delay` is how long to wait for the attempt in flight before starting another,
as a number or as a schedule read with the number of attempts already started.
**Set it near the latency you are willing to accept, around the p95 of the
call, not the p50**, or every call is sent twice.

Losing attempts are abandoned as soon as one answers, which works because every
attempt already has its own signal. The winner's signal is left intact, because
aborting it would cut off a result still being read.

Left alone, a hedge answers latency only: a failure passes straight to the
caller, and repeating it is `retry`'s job. `shouldHedge` makes the hedge start
the next attempt immediately on a failure instead of waiting out the delay,
which is a decision with the same shape as `shouldRetry` and is why it has no
default.

A hedge sends a second request exactly when the dependency is slow, which is
exactly when it can least afford the traffic. Share a `budget` with the retry
above it. If every attempt fails, the last failure is rethrown as it was.

## `SingleFlight`

Collapses concurrent calls that share a key into one call.

```ts
const shared = new SingleFlight();

const today = await shared.run("rates:today", readRates, signal);
```

It stores nothing once a call settles: the next caller starts a new one. That
is the whole difference between this and a cache, and it is why there is no
expiry to configure. A cache is storage with an invalidation story, which
belongs in your data layer.

The shared call is abandoned only when every caller has abandoned it. Each
caller's signal detaches that caller, and the last one to leave aborts the
work. Read `shared.inFlight` and `shared.has(key)`, or use `shared.policy(key)`
to run everything a policy wraps under one key.

## `fallback`

Answers with something rather than failing, once everything else has been
tried: stale data, an empty list, a degraded result.

```ts
const rates = await fallback(() => cached)(policy(readRates))();
```

It belongs outermost, where the failure it sees is the one the caller would
otherwise have caught. It is a `TypedPolicy` rather than a `Policy` because it
produces a result, so it wraps a stack rather than sitting in one.

`shouldFallback` narrows which failures deserve the substitute. It defaults to
all of them, which is the honest default here: unlike a retry, answering with
something is never worse for the dependency. The caller giving up is not a
failure to answer for, so an aborted call still rejects.
