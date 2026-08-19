#!/bin/sh
# Test fixture host: emits a partial stream then dies to SIGKILL (no result
# event, code null, signal SIGKILL) — must be reported as a failed run, not
# exit-0 success.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1","model":"opus"}'
printf '%s\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"partial answer"}]},"usage":{"input_tokens":10,"output_tokens":3}}'
kill -9 $$
