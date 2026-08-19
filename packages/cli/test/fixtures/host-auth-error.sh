#!/bin/sh
# Test fixture host: an unauthenticated claude run. Emits the same stream-json
# shape as claude -p --output-format stream-json when not logged in, then
# exits 1. Offline, deterministic, cross-platform (POSIX sh).
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1","model":"opus"}'
printf '%s\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","is_api_error_message":true}'
printf '%s\n' '{"type":"result","is_error":true,"num_turns":1,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
exit 1
