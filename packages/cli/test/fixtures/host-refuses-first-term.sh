#!/bin/sh
# Test fixture host: refuses the FIRST polite signal it receives, stands down on
# the next one.
#
# A bridged run's child is the user's interactive shell for the first moments of
# its life, and that shell discards a SIGTERM that arrives while it is starting
# up — so a stop that offers the signal only once can lose it before the host
# ever sees it. This host keeps count and exits 7 on the second signal: a run
# that ends at all is the proof that the polite signal was offered again.
#
# The trap is installed BEFORE the first line is printed, so a caller that waits
# for that line knows this host is counting.
n=0
trap 'n=$((n + 1)); [ "$n" -ge 2 ] && exit 7' TERM
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s-refuses","model":"opus"}'
while :; do
  sleep 0.1
done
