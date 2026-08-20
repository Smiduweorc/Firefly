# firefly-js

![logo](https://raw.githubusercontent.com/Smiduweorc/firefly/master/assets/logo.png)

**Firefly is for projects that will never have a service mesh: retries, deadlines, circuit breakers, bulkheads, rate limits and hedges for the calls one process makes, with every number chosen by you.**

It is a library, not a sidecar. You describe an upstream once, hand it the calls you make, and it decides what happens when they fail: how many times to try, how long to wait first, and when to stop trying at all.

No runtime dependencies, and nothing happens at import time.

## Firefly is not for you if you

- **run a service mesh.** Envoy or Istio is already retrying and ejecting outliers at the sidecar, and two layers of retries multiply each other.
- **need fleet-wide state**: every count here belongs to one process, so twenty replicas mean twenty breakers and twenty recovery probes.
- **want it to decide what a failure is.** `shouldRetry` has no default. A 409 is fatal to one caller and expected by another, and the types will not let you skip the question.
- **want defaults for the numbers.** There are none. Attempts, deadline and breaker are all required, because they are properties of your traffic rather than of this package.
- **need to protect a server from its callers.** This is for the calls you make, not the traffic you receive.
- **want a `fetch` replacement, a cache or a metrics pipeline.** It performs no I/O, stores no responses and writes nothing anywhere. `onEvent` hands you the decisions and the rest is yours.

## How it works

A policy is a function that wraps a unit of work and hands back something of the same shape:

```ts
type Action<T> = (signal: AbortSignal) => Promise<T>;
type Policy = <T>(action: Action<T>) => Wrapped<T>;
```

Because what goes in matches what comes out, policies nest, and a stack of them is still one function you call. `retry` around `timeout` around your work is a retry of a deadline.

Four things follow from that shape:

- **Firefly never performs the work.** You pass the action in: a `fetch`, a database query, anything else returning a promise.
- **Every attempt gets an `AbortSignal`**, so a deadline aborts the attempt instead of only giving up on waiting for it. An action that watches its signal stops working.
- **Your failures come back as themselves.** When the attempts run out, the last error is rethrown unchanged. Only Firefly's own refusals are Firefly errors: a deadline, an open circuit, a full bulkhead, an exhausted limiter.
- **State is an object you construct.** A breaker built inside a client factory is a breaker per client, which measures nothing. You make one and share it deliberately.

The order the policies go in has one right answer, so `Dependency` assembles it for you, and `stack` throws on an arrangement that cannot work.

## Quick start

```sh
npm install firefly-js
```

**1. Describe the thing you call.** A `Dependency` is one upstream and every decision you have made about calling it. Build it once, next to the client it protects, and share it.

```ts
import { Dependency, exponential, retryAnything } from "firefly-js";

export const rates = new Dependency({
	name: "rates",
	attempts: 3,
	backoff: exponential({ base: 200, max: 5_000 }),
	shouldRetry: retryAnything,
	deadline: 2_000,
	breaker: { threshold: 5, resetAfter: 30_000 },
});
```

Every field is required. There is no default attempt count and no default deadline.

**2. Call through it.**

```ts
const today = await rates.run((signal) => readRates(signal));
```

**3. Decide the per-call parts at the call.** Two things belong to one call rather than to the dependency, so they are options on `run`:

```ts
const today = await rates.run(readRates, {
	share: "today",         // twenty callers, one request
	fallback: () => cached, // an answer for a call that failed all the way through
});
```

**4. Or hand the same policy to an HTTP client.** `transport` wraps a `fetch`-shaped function, so a client never imports Firefly:

```ts
import { retryableTransportError, transport } from "firefly-js/http";

const api = new ApiClient({
	baseUrl: "https://api.acme.com/v1",
	transport: transport(fetch, rates.policy),
});
```

Inside a transport a 429 arrives as an ordinary resolved `Response`, so use `retryableTransportError` as that dependency's `shouldRetry`.

**5. Read what it is doing.** Reading state changes nothing, so a health endpoint can call it:

```ts
app.get("/health", () => rates.health());
// { name: "rates", circuit: "closed", failures: 0, inFlight: 0, queued: 0 }
```

## Documentation

Guides and the full API reference: **<https://smiduweorc.github.io/firefly/>**

| Guide | What it covers |
| --- | --- |
| [Concepts](https://smiduweorc.github.io/firefly/documents/Concepts.html) | Actions, policies, stack order, signals, clocks, events, errors |
| [Dependency](https://smiduweorc.github.io/firefly/documents/Dependency.html) | The front door: every option, per-call options, health |
| [Policies](https://smiduweorc.github.io/firefly/documents/Policies.html) | Each policy on its own, and the numbers that matter |
| [HTTP](https://smiduweorc.github.io/firefly/documents/HTTP.html) | `firefly-js/http`, body replay, `Retry-After`, Aphid and dung beetle |
| [Testing](https://smiduweorc.github.io/firefly/documents/Testing.html) | Virtual clocks, and asserting on decisions |
| [Boundaries](https://smiduweorc.github.io/firefly/documents/Boundaries.html) | What this package will not do, and where that work goes |

The guide sources live in [`guides/`](https://github.com/Smiduweorc/firefly/tree/master/guides).

## Where it sits

Firefly is the third of three packages that share one boundary. [Aphid](https://github.com/Smiduweorc/Aphid-template) and [dung beetle](https://github.com/Smiduweorc/dung-beetle-template) describe an API and report what happened. Firefly is where "what to do about it" lives, and it depends on neither at build time or run time.

It is built for one process. [Boundaries](https://smiduweorc.github.io/firefly/documents/Boundaries.html) has the full list of what that rules out.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` and the barrels to `dist/` with type declarations. |
| `npm run typecheck` | Type-check the package and the tests without emitting. |
| `npm run lint` | Run ESLint. |
| `npm test` | Run the test suite with the Node test runner via `tsx`. |
| `npm run test:dist` | Build, then run the tests that import `dist/`. |
| `npm run docs` | Build the documentation site into `docs/`. |
| `npm run changelog` | Regenerate `CHANGELOG.md` from the commit history. |

> Publishing and deployment are handled manually (custom npm settings), so no release/publish workflow is included here.

## License

MIT
