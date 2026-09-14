#!/bin/sh
# Test fixture host: announces itself, then stays alive producing nothing.
# The cancellation path needs a child that would otherwise outlive the test —
# no `result` event is ever emitted, so the only way this run ends is a signal.
#
# `exec` matters: without it the shell is the direct child and the sleep keeps
# the stdout pipe open behind it, so killing the shell leaves the reader waiting
# for a grandchild that never got the signal.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s-slow","model":"opus"}'
exec sleep 30
