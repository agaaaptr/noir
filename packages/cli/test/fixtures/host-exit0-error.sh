#!/bin/sh
# Test fixture host: an in-run API failure where the claude CLI exits 0 but
# signals is_error:true on the result event (anthropics/claude-code#79500 —
# exit code and subtype are NOT reliable; is_error is the truthful signal).
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1","model":"opus"}'
printf '%s\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"overloaded, retry"}]},"error":"overloaded","is_api_error_message":true}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
exit 0
