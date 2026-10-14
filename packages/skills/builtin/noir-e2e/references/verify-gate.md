# Register e2e as a verify-gate check

The verify gate already runs arbitrary shell checks from config. Register the
e2e run there so `noir task verify` runs it and records the result as evidence,
instead of running it once by hand.

## Add the check

In `.noir/config.yml`, under `workflow.gate.verify.checks`, add a check whose
command runs the project's e2e suite:

```yaml
workflow:
  gate:
    verify:
      checks:
        - name: e2e
          command: pnpm test:e2e
          tier: hard
```

## Tier

- `hard`: a failing e2e run blocks advancing to done. Use it for a flow the
  task actually changes.
- `soft`: the run is recorded but does not block. Use it while a suite is
  being brought up.

## Verify

Run `noir task verify --check e2e` (or the whole verify) and confirm the
gate records the e2e result. The e2e run is now part of "done", not a side
note.
