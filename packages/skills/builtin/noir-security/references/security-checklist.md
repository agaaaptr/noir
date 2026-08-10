# Security review checklist — the baseline every feature should pass

Deep reference for `noir-security`. A methodical checklist for reviewing code for vulnerabilities before shipping.

## Surface area first

Before looking at specific attacks, map the surface:

- What DATA enters the system? (user input, webhooks, files, network)
- What EXITS? (responses, logs, external calls, rendered pages)
- WHO can call each path? (unauthenticated? role-gated? internal-only?)
- What TRUST boundaries exist? (the point where untrusted data meets trusted code)

## Injection (the classic)

- **SQL** — is any user input concatenated into a query string? Parameterized queries / prepared statements everywhere. No `eval`-style dynamic queries.
- **Shell** — is user input passed to a shell command? Use `execFile`/argument arrays, never string interpolation into `sh -c`.
- **Template/XSS** — is user input rendered into HTML/JS unescaped? Framework auto-escaping ON, no `dangerouslySetInnerHTML`-style bypass without a reason.
- **Path** — is user input used to build a filesystem path? Normalize + validate it stays inside the intended root (no `..` traversal).

## Auth & authorization

- **Every data-touching endpoint is gated** — a missing `if (isAdmin) return;` before a `return data` leak is the classic bug (the "forgot the return" pattern).
- **Auth check happens BEFORE data access**, not after.
- **Failed auth doesn't reveal** whether the user or password was wrong (in login forms).
- **Tokens/secrets** — any hard-coded key, committed `.env`, or token in a log? Scan the diff, not just the code.

## Data exposure

- **Over-fetching** — does an API return more fields than needed (password hashes, internal ids)?
- **Logging** — do logs contain tokens, PII, or full request bodies? Sanitize before logging.
- **Error messages** — do errors leak stack traces or internal paths to the client?

## Dependencies

- **New packages** — any added this change? Check for known vulnerabilities and whether they're pinned to a safe version.
- **Supply chain** — is a package pulled from a trusted source? Any `curl | bash` installs?
- **Transitive** — a lockfile bump that pulls a vulnerable transitive dep?

## How to report

One finding per entry, each with:

- **Severity** — critical / high / medium / low (impact × likelihood).
- **Location** — file:line.
- **The attack** — a concrete "an attacker could X by Y."
- **The fix** — a specific remediation.

**Rule:** never ship a critical/high finding unaddressed. If it must ship, the risk is explicitly accepted by the user with a tracking issue — never silently.
