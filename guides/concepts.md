---
title: Concepts
---

# Concepts

Everything in this package is built out of two types and one composition rule.
Once those are clear, the individual policies are just names for behaviours.

## Actions and policies

An **action** is the work. It takes a signal and returns a promise:

```ts
type Action<T> = (signal: AbortSignal) => Promise<T>;
```

A **policy** wraps an action and hands back a wrapped action:

```ts
type Policy = <T>(action: Action<T>) => Wrapped<T>;
type Wrapped<T> = (signal?: AbortSignal) => Promise<T>;
```

`Wrapped` is an `Action` whose signal is optional, which is what lets policies
nest and still be callable at the top. The outermost call has no policy above
it to supply a signal, so it may be called with none; every policy below always
receives a real one.

Applying a policy is an ordinary function call, and so is running the result:

```ts
const guarded = timeout(2_000)(readRates);
const today = await guarded();
```

Nesting is how you combine them. `retry` around `timeout` around the work is a
retry of a deadline, because the thing `retry` repeats is the deadline-wrapped
attempt:

```ts
const today = await retry(options)(timeout(2_000)(readRates))();
```

`fallback` is the one exception to the shape. It produces a result of its own,
and a result has a type, so it is a `TypedPolicy<T>` rather than a `Policy`. It
wraps a stack instead of sitting inside one.

## Composing: `stack`

`stack` composes left to right, outermost first, so the arguments read the way
the stack is drawn. `stack(a, b)(action)` is `a(b(action))`.

```ts
const policy = stack(
	retry({ attempts: 3, backoff: exponential({ base: 100 }), shouldRetry }),
	breaker.policy,
	limiter.policy,
	bulkhead.policy,
	timeout(2_000)
);
```

### The order, and why it is checked

Policy order is not a preference. Most of the wrong arrangements are quietly
wrong: they run, they look fine, and they measure or protect nothing. So each
policy in this package is labelled with what it does, and `stack` throws a
`TypeError` when a labelled policy sits outside one that must contain it.

| Position | Policy | Why there |
| --- | --- | --- |
| Outermost | `fallback` | Where it can answer for a call that failed all the way through. |
| | `SingleFlight` | Outside the retry, so callers sharing a key share its attempts too. |
| | `retry` | Outside the breaker, so every attempt is recorded rather than one outage counting once. |
| | `hedge` | Inside the retry and outside the breaker, so each branch is recorded on its own. |
| | `CircuitBreaker` | Inside the retry and outside the waiting policies, so an open circuit refuses instead of queueing for a slot it will not use. |
| | `RateLimiter` | Outside the bulkhead, so waiting for a token does not hold a concurrency slot. |
| | `Bulkhead` | Directly around the work, where the count of in-flight attempts is the thing being bounded. |
| Innermost | `timeout` | Innermost, because it is a deadline per attempt and not a budget for the operation. |

Two policies of the same kind may sit next to each other. Policies you write
are unlabelled, so `stack` passes them through without an opinion. Label your
own with `tag(policy, kind)` to have it held to the same order, read a label
back with `kindOf(policy)`, and use `stack.unchecked(...)` for an arrangement
you mean and this package does not know about.

The thrown message names both policies and where the outer one belongs, so the
fix is in the error rather than in this page.

## Signals and cancellation

Cancellation is the reason actions take a signal, and it is what makes a
deadline more than a stopwatch.

- The signal you pass to a wrapped action is the **caller's** signal. Aborting
  it abandons the whole operation.
- `timeout` and `hedge` derive a **per-attempt** signal, so an attempt is
  aborted either when the caller gives up or when that attempt alone is
  abandoned. The link lasts as long as the attempt: once the call has settled
  the attempt's signal stops following the caller, so a signal you hand to
  every call — a shutdown signal, say — does not collect a listener per call.
- An action that watches its signal stops working when the attempt is
  abandoned. An action that ignores its signal cannot be cancelled by anything,
  here or elsewhere, and the rejection is still on time.

A caller's abort is never treated as a failure to repeat. `retry`, `fallback`
and `hedge` all check the outer signal first and rethrow rather than acting.

### Deadlines and budgets

They are different things and this package spells them differently.

- `timeout(ms)` is a deadline for **one attempt**. Three attempts under a two
  second deadline can take six seconds.
- `maxElapsed` on `retry` is a budget for the **whole operation**. No attempt
  is started once that much time has passed since the first one.

The two are connected: a deadline that would run past the operation's budget is
cut short, so a final attempt cannot overshoot the budget it was started under.

## The clock

Every policy reads time through one interface:

```ts
interface Clock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

Nothing calls `Date.now` or `setTimeout` directly, and constructing a policy
starts no timer. Pass a `clock` and a five minute backoff schedule runs in the
time it takes to resolve a promise. See [Testing](./testing.md).

## Events

Every decision a policy makes is handed to an `onEvent` sink as a plain value:

```ts
const policy = retry({
	attempts: 3,
	backoff: exponential({ base: 100 }),
	shouldRetry,
	onEvent: (event) => metrics.count(event.type),
});
```

The union is closed, and every member carries the numbers behind the decision:

| Event | Carries | Emitted by |
| --- | --- | --- |
| `attempt` | `attempt` | `retry`, once per try |
| `retry` | `attempt`, `delay`, `error` | `retry`, once per wait |
| `budget-exhausted` | `tokens` | `retry`, `hedge` |
| `timeout` | `ms`, `elapsed` | `timeout` |
| `hedge` | `attempt` | `hedge`, per attempt past the first |
| `fallback` | `error` | `fallback` |
| `circuit-open` | `openedAt`, `retryAt`, `error` | `CircuitBreaker` |
| `circuit-half-open` | `openedAt` | `CircuitBreaker` |
| `circuit-close` | | `CircuitBreaker` |
| `rate-limited` | `retryAt`, `rejected` | `RateLimiter` |
| `bulkhead-queued` | `inFlight`, `queued` | `Bulkhead` |
| `bulkhead-rejected` | `inFlight`, `queued` | `Bulkhead` |
| `body-too-large` | `limit`, `declared` | `transport` |

Every event also carries `call`, an id shared by every event from the same
call. It is what lets a sink tell three attempts of one call from one attempt
of three calls, and it survives the derived signals, so a hedged branch reports
under the call it belongs to.

A throw from your sink is caught and dropped. A failing metrics sink must not
fail the call it was reporting on.

## Errors

A `FireflyError` means Firefly declined: it stopped waiting, refused to start,
or had nowhere to run the work. A failure that came from your work is rethrown
unchanged, so one `instanceof` separates the two.

| Class | Raised when | Carries |
| --- | --- | --- |
| `TimeoutError` | An attempt passed its deadline. | `ms`, `elapsed` |
| `CircuitOpenError` | The circuit was open, so nothing was sent. | `openedAt`, `retryAt`, and `cause`, the failure that opened it |
| `BulkheadFullError` | Concurrency and queue were both full. | `concurrency`, `queued` |
| `RateLimitError` | No token, and the limiter is set to reject rather than wait. | `retryAt` |
| `HedgeAbandonedError` | A hedged attempt lost the race. | `attempt` |

`HedgeAbandonedError` is the reason a losing attempt's signal is aborted with.
It is not reported to the caller, so seeing one means an action recorded its
own cancellation somewhere.

When retries run out, the last failure is rethrown exactly as it was. This is
why the `HttpError` a caller catches is the one the API produced, carrying the
API's own body, whether or not a policy tried three times to avoid it.
