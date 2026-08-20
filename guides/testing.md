---
title: Testing
---

# Testing

A resilience harness is mostly waiting, and a test suite that actually waits is
a test suite nobody runs. Every policy in this package reads time through one
interface, so a test can substitute it:

```ts
interface Clock {
 now(): number;
 sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

Nothing calls `Date.now` or `setTimeout` directly. Pass a `clock` to any policy
or to a `Dependency` and a five minute backoff schedule runs in the time it
takes to resolve a promise. This package's own suite has no real sleeps in it.

## A virtual clock

There is no test double in the published surface, because a clock you control
is twenty lines and a clock you cannot see inside is worse than one you wrote:

```ts
import type { Clock } from "firefly-limiter";

interface Timer {
 readonly at: number;
 readonly fire: () => void;
}

const flush = (): Promise<void> =>
 new Promise((resolve) => setImmediate(resolve));

export class VirtualClock implements Clock {
 #now = 0;
 #timers = new Set<Timer>();

 now(): number {
  return this.#now;
 }

 sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
   return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
   const timer: Timer = {
    at: this.#now + ms,
    fire: () => {
     signal?.removeEventListener("abort", abort);
     resolve();
    },
   };

   const abort = (): void => {
    this.#timers.delete(timer);
    reject(signal?.reason);
   };

   this.#timers.add(timer);
   signal?.addEventListener("abort", abort, { once: true });
  });
 }

 /** Moves time forward by `ms`, firing whatever falls due on the way. */
 async advance(ms: number): Promise<void> {
  const target = this.#now + ms;

  for (;;) {
   await flush();

   let next: number | undefined;
   for (const timer of this.#timers) {
    if (next === undefined || timer.at < next) {
     next = timer.at;
    }
   }

   if (next === undefined || next > target) {
    break;
   }

   this.#now = Math.max(this.#now, next);

   for (const timer of [...this.#timers]) {
    if (timer.at <= this.#now) {
     this.#timers.delete(timer);
     timer.fire();
    }
   }
  }

  this.#now = target;
  await flush();
 }
}
```

The `flush` between steps is what lets the promises woken by one timer settle
before the next one fires. Without it, time moves past work that had not had a
chance to run.

## Making jitter exact

Full jitter is on by default, so a delay is a range rather than a number. Pass
`random` to pin it:

```ts
const backoff = exponential({ base: 100, random: () => 1 });

assert.equal(backoff(1), 100);
assert.equal(backoff(2), 200);
```

`jitter: "none"` does the same thing when you would rather say it that way.

## Asserting on decisions

`onEvent` is the seam for asserting on what a policy decided, rather than
inferring it from timing:

```ts
const events: FireflyEvent[] = [];

const policy = retry({
 attempts: 3,
 backoff: constant(1_000, { jitter: "none" }),
 shouldRetry: retryAnything,
 onEvent: (event) => events.push(event),
 clock,
});

const result = policy(failsTwiceThenSucceeds)();
await clock.advance(5_000);

await result;
assert.deepEqual(
 events.map((event) => event.type),
 ["attempt", "retry", "attempt", "retry", "attempt"]
);
```

Every event carries `call`, so a test that runs several calls at once can group
them without threading an id through the action.

## Driving a breaker

Time is the only thing standing between open and half-open, so a breaker test
is a loop and an `advance`:

```ts
const breaker = new CircuitBreaker({ threshold: 2, resetAfter: 30_000, clock });
const guarded = breaker.policy(failing);

await assert.rejects(guarded());
await assert.rejects(guarded());

assert.equal(breaker.state, "open");
await assert.rejects(guarded(), CircuitOpenError);

await clock.advance(30_000);
assert.equal(breaker.state, "half-open");
```

Reading `state`, `failures`, `recorded`, `tokens`, `inFlight` and `queued`
changes nothing, so an assertion cannot move the thing it is measuring.

## Actions that do not settle

Testing a bulkhead's queue or a hedge's race needs work that hangs until the
test lets it go. Two shapes cover almost everything:

```ts
/** Never settles on its own; rejects when its signal aborts. */
const pending = (signal: AbortSignal): Promise<never> =>
 new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), {
   once: true,
  });
 });

/** A promise the test settles by hand. */
function deferred<T>() {
 let resolve!: (value: T) => void;
 let reject!: (reason: unknown) => void;
 const promise = new Promise<T>((res, rej) => {
  resolve = res;
  reject = rej;
 });
 return { promise, resolve, reject };
}
```

`pending` is also how you check that a policy really cancels: if the promise
rejects with your `TimeoutError`, the attempt's signal was aborted rather than
merely abandoned.
