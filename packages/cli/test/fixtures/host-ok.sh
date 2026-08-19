#!/bin/sh
# Test fixture host: a clean successful run (assistant text + is_error:false).
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1","model":"opus"}'
printf '%s\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello from host"}]},"usage":{"input_tokens":10,"output_tokens":5}}'
printf '%s\n' '{"type":"result","is_error":false,"num_turns":1,"total_cost_usd":0,"usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
