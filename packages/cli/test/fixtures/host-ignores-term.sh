#!/bin/sh
# Test fixture host: a host that refuses the polite signal.
# The interrupt contract has to escalate — ask with SIGTERM, then force with
# SIGKILL after the grace — and this is the only way to prove the forcing step
# actually runs, rather than the host simply dying as told.
#
# It never exits on its own: the run it is part of is supposed to end with a
# forceful kill.
trap '' TERM
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s-deaf","model":"opus"}'
while :; do sleep 0.2; done
