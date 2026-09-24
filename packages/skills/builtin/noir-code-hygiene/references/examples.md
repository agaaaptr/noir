<!-- Worked examples for the noir-code-hygiene skill.

     This file exists to show the shapes the rules forbid, so it must contain
     them. It therefore declares the exemption the rules honour with the marker
     below, alone on its line and above the first finding.

     The pairs follow the same shape as the skill: what arrives first, then the
     same thing after the pass. The code is the same both times; what changes is
     what the text says about it. -->
<!-- noir-hygiene: exempt -->

# Worked examples

One pair per defect. The first snippet in each pair is what a draft or a
generator tends to produce; the second is the same code after the pass the
skill describes. Read the pair for the defect you met rather than the whole
file.

## Decorative separators and banners

Before:

```ts
// ============================================================
// ====================== Users ===============================
// ============================================================

/** Loads a user. The timeout bounds a hung request, not a healthy one. */
export async function fetchUser(id: string): Promise<User> {
  return client.get(`/users/${id}`, { timeoutMs: 5000 });
}
```

After:

```ts
/** Loads a user. The timeout bounds a hung request, not a healthy one. */
export async function fetchUser(id: string): Promise<User> {
  return client.get(`/users/${id}`, { timeoutMs: 5000 });
}
```

## Workflow narration

Before:

```ts
async function sync(): Promise<void> {
  // Step 1: read the config.
  const cfg = await readConfig();
  // Step 2: resolve the profile named on the command line.
  const profile = pick(cfg, name);
  // Step 3: start the daemon.
  await start(profile);
}
```

After:

```ts
async function sync(): Promise<void> {
  // The profile is resolved against the config's profile table, so the config
  // has to be read first — a profile name is not self-describing.
  const cfg = await readConfig();
  const profile = pick(cfg, name);
  await start(profile);
}
```

## Restating the obvious

Before:

```ts
// Increments the retry counter.
retries++;
```

After:

```ts
// Per request, not per host: a retry storm against one endpoint must not
// exhaust the budget the other endpoints share.
retries++;
```

## Empty labels

Before:

```ts
// TODO: handle the timeout case.
export async function fetchUser(id: string): Promise<User> {
  return client.get(`/users/${id}`, { timeoutMs: 5000 });
}
```

After:

```ts
// The client rejects rather than returning a partial page once the request
// budget is gone, so callers must handle a rejected promise. Revisit once the
// export job needs partial results.
export async function fetchUser(id: string): Promise<User> {
  return client.get(`/users/${id}`, { timeoutMs: 5000 });
}
```

## Stale comments

Before:

```ts
// Backs off for 30 seconds between retries, matching the gateway's window.
const BACKOFF_MS = 250;
```

After:

```ts
// The gateway rate-limits per second, so a longer backoff only delays the
// request the user is already waiting on.
const BACKOFF_MS = 250;
```

## Decorative icons and emoji

Before:

```ts
// ✅ The second read is served from cache.
// 🚀 Ready to ship.
export function read(id: string): User | undefined {
  return cache.get(id);
}
```

After:

```ts
// Read twice and the second read makes no request, so a caller may treat a
// hit as free.
export function read(id: string): User | undefined {
  return cache.get(id);
}
```

## Verbosity

Before:

```ts
/**
 * Loads a user.
 * This function takes an id and returns the user it names.
 * It calls the client, which performs the HTTP request.
 * If the request fails, the error is propagated to the caller.
 * The caller decides what to do with the error.
 * The id is validated before the request is made.
 * An invalid id therefore never reaches the client.
 * The validation is a format check only.
 * It does not confirm that the user exists.
 * A missing user produces the client's own error.
 * The result is not cached.
 * A second call repeats the request.
 */
export async function fetchUser(id: string): Promise<User> {
  assertId(id);
  return client.get(`/users/${id}`);
}
```

After:

```ts
/**
 * Loads a user. The id is checked for shape, not for existence, so a
 * well-formed id that names nobody fails with the client's own error.
 */
export async function fetchUser(id: string): Promise<User> {
  assertId(id);
  return client.get(`/users/${id}`);
}
```

## Internal jargon

Before:

```ts
// Part of the checkout rework — see the planning note, section 4.
const flags = parseFlags(raw);
```

After:

```ts
// Flags arrive as a comma-separated list from the runner's environment: a flag
// set for a preview deploy is not set on the production runner.
const flags = parseFlags(raw);
```

## Unstated assumptions

Before:

```bash
# Restart it after the migration.
sudo systemctl restart api
```

After:

```bash
# Run on the application host, not the database host. The API reads the schema
# at boot and keeps it, so it serves the old one until it restarts.
sudo systemctl restart api
```

## Which tier each shape lands in

The divider, the ordinal narration and the decorative emoji are mechanical, and
the gate fails on them — through `noir skills lint` for a skill body and through
`noir doctor` for a repository. The marker with no owner and the long comment
block are warnings instead: a marker is sometimes the right note and a block is
sometimes the right length, so those rules ask whether the line earns its place
rather than forbidding the shape.

Restating, stale text, jargon and unstated assumptions have no pattern behind
them at all, so only a reader catches them. That is why the skill covers them
beside the rules the gate can see: the pass is one pass, not two.
