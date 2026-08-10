# Backend patterns — contract-first, layered, resilient

Deep reference for `noir-backend`. Practical patterns for APIs, schemas, and server logic that scale without collapsing.

## Contract-first

The API contract is the interface BOTH sides read. Before code:

1. **Define the endpoint** — method, path, request body, response body, error shapes.
2. **Validate the schema** — the request is validated at the boundary (a schema/Zod/DTO), not in the handler.
3. **Document it** — the contract (even a short markdown or a type) is the source both sides build against.

**One endpoint = one responsibility.** A focused handler is testable; a "do everything" endpoint is not. If an endpoint has a second verb's worth of behavior, split it.

## Layered error handling

Every layer reports a STRUCTURED error; the client never sees a raw stack trace:

```
API → ValidationError (400, field)
   → AuthError (401/403)
   → NotFoundError (404)
   → RateLimitError (429)
   → ConflictError (409)
   → InternalError (500, no internals leaked)
```

- Each layer maps its failures to a typed error with a stable code + human message.
- The client gets `{error: {code, message}}`, never a stack trace or internal path.
- Log the full error server-side; return only the safe surface to the client.

## Data & migrations

- **Schema changes go through migrations** — never alter a table by hand. Every migration is forward + rollback.
- **Indexes** — add indexes for the query patterns the API actually uses, not speculative ones.
- **Transactions** — multi-step writes (create + link + notify) run in a transaction; a failure mid-way rolls back cleanly.

## Security (baseline)

- **Auth on every data-touching endpoint** — the gate is before the data access, with no "forgot the return."
- **Validate at the boundary** — reject malformed input before it reaches service logic.
- **Rate-limit write endpoints** — public creates/updates get a limit + 429 backoff.
- **Secrets** — tokens via env/config, never committed. Credentials never logged.

## Resilience

- **Idempotency** — writes accept an idempotency key so a retried request doesn't double-create.
- **Timeouts + retries** — outbound calls have a timeout and a bounded retry (never infinite).
- **Graceful degradation** — a downstream outage degrades (cached fallback, clear error), never crashes the process.
- **Observability** — a request id threads through the layers so a failure is traceable; log the request id with each error.

## Good / bad

Good: a validated, single-purpose endpoint that returns typed errors, uses migrations, and has a rate limit.
Bad: an unvalidated catch-all endpoint that throws a raw error to the client, mutates the DB by hand, and has no auth check before the data leak.
