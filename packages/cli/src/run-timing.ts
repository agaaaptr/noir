// Run timing constants shared by the orchestrator and the interrupt ladder.
//
// Kept out of `run-interrupt.ts` and `orchestrator.ts` on purpose: the two
// already form an import edge (run-interrupt imports the child-signalling
// helper from the orchestrator), so a second edge in the other direction would
// be a cycle. A run-timing leaf breaks that cycle while giving every consumer
// one source of truth for how long the polite-stop grace lasts.

/**
 * How long the polite signal gets before the forceful one. A host that is
 * mid-request needs a moment to wind down and finish writing its own record of
 * the session; a host that ignores the signal entirely must not hold the
 * terminal past this.
 */
export const INTERRUPT_GRACE_MS = 5000;
