// Host-neutral capture schema for @noir-ai/memory.
//
// The bridge between a HOST's auto-capture surface and Noir's `memory_save`. A
// host hook (Claude Code PreToolUse / PostToolUse / UserPromptSubmit / Stop, or
// any future host's equivalent) emits a host-neutral {@link CaptureEvent}; this
// module's pure {@link toSaveInput} mapper projects it into a {@link SaveInput}
// that flows through the SAME `MemoryEngine.save` path as a deliberate save.
//
// Capture is ALWAYS local + free (blueprint D6): {@link toSaveInput} is
// a PURE function — no I/O, no network, no LLM, no store. It builds the input;
// the engine's `save` performs the write. There is deliberately NO source field
// on {@link SaveInput} (it is set at save time), so an event routed through
// `memory_save` lands with `source:'explicit'`; {@link captureSource} is exported
// for a dedicated `noir memory capture` command (S9) that tags provenance as
// `'auto:<hook>'` without going through the MCP `memory_save` envelope.
//
// This module does NOT install anything. Auto-capture is OPT-IN: the user wires
// a host hooks block deliberately (see templates/claude-hooks.md). `noir init` /
// `noir sync` NEVER install hooks (no surprise captures, no privacy
// surface the user did not ask for).
//
// Canonical ProjectId (D6): {@link CaptureEvent.project} is the canonical id the
// capture command resolved from cwd — NEVER a filesystem path. The mapper copies
// it through unchanged (it is recorded on the observation at save time).

import type { MemorySource, MemoryType, ProjectId, SaveInput } from './types.js';

// ---------------------------------------------------------------------------
// Hook event names (open enum — forward-compat with new host hook names)
// ---------------------------------------------------------------------------

/**
 * Known host hook events Noir can capture (the four Claude Code hooks the v1
 * template targets, spec §5). The list is intentionally NOT closed:
 * {@link CaptureEventType} also accepts any unknown string so a future host's
 * hook names round-trip through the mapper without a code change (mirrors the
 * open-enum taxonomy in types.ts).
 */
export const CAPTURE_HOOKS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const;

/** One of {@link CAPTURE_HOOKS} OR any host-defined hook name (open enum). */
export type CaptureEventType = (typeof CAPTURE_HOOKS)[number] | (string & {});

// ---------------------------------------------------------------------------
// Defaults — the opinionated capture policy (spec §5)
// ---------------------------------------------------------------------------

/**
 * Hook events captured by DEFAULT. Persist session-end summaries + the
 * prompts a user submits; SKIP the noisy per-tool events (`PreToolUse` /
 * `PostToolUse` fire on every tool call and would flood memory + leak tool
 * inputs the user did not ask to remember). A user opts INTO tool-event capture
 * by passing a custom {@link CapturePolicy.hooks}.
 */
export const DEFAULT_CAPTURE_HOOKS: readonly CaptureEventType[] = ['Stop', 'UserPromptSubmit'];

/**
 * The default capture policy: capture {@link DEFAULT_CAPTURE_HOOKS} only. Used
 * when {@link toSaveInput} is called with no `policy` argument. Host-neutral +
 * conservative — the user owns the policy.
 */
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = { hooks: DEFAULT_CAPTURE_HOOKS };

// ---------------------------------------------------------------------------
// CaptureEvent (the host-neutral schema)
// ---------------------------------------------------------------------------

/**
 * The structured payload a host hook forwards. All fields optional — a hook
 * populates whichever it has (a `Stop` hook carries a `summary`; a
 * `UserPromptSubmit` hook carries the `prompt`; a tool hook carries `toolName`
 * + `toolInput`). Unknown extra fields are tolerated (the mapper reads only the
 * fields below), so a host can forward its raw stdin without shape-massaging.
 */
export interface CapturePayload {
  /** Tool name for tool hooks (e.g. `'Bash'`, `'Edit'`, `'Write'`). */
  toolName?: string;
  /** The tool's input object (e.g. `{ command: 'npm test' }`, `{ file_path }`). */
  toolInput?: unknown;
  /** The submitted prompt text (`UserPromptSubmit`). */
  prompt?: string;
  /** A session-end summary (`Stop`) — free text the host derived or was given. */
  summary?: string;
}

/**
 * A host-neutral capture event. Built by a host hook (or a `noir memory capture`
 * CLI) from whatever the host emitted on stdin, then handed to
 * {@link toSaveInput}. The shape is deliberately minimal + portable so it is not
 * tied to Claude Code's stdin schema (a future host adapter translates its own
 * payload into this).
 *
 * `project` is the CANONICAL project id (NEVER a filesystem path — blueprint
 * D6); the capture command resolves it from `cwd` before constructing the event.
 */
export interface CaptureEvent {
  /** Hook event name (open enum — {@link CaptureEventType}). */
  event_type: CaptureEventType;
  /** Epoch millis of the event (host-supplied or `Date.now()` at capture). */
  ts: number;
  /** Host session id if known, else null (recorded on the observation). */
  sessionId: string | null;
  /** Canonical project identifier (NEVER a filesystem path — D6). */
  project: ProjectId;
  /** The event-specific fields (see {@link CapturePayload}). */
  payload: CapturePayload;
}

// ---------------------------------------------------------------------------
// Capture policy
// ---------------------------------------------------------------------------

/**
 * An opinionated capture policy. Controls WHICH hook events are persisted when
 * {@link toSaveInput} is called. Defaults to {@link DEFAULT_CAPTURE_POLICY}
 * (session summaries + submitted prompts only). The user owns this — it is the
 * one knob that keeps auto-capture from flooding memory (R3).
 */
export interface CapturePolicy {
  /**
   * Hook events to capture. An event whose `event_type` is NOT in this list is
   * skipped (`toSaveInput` returns `null`). Defaults to
   * {@link DEFAULT_CAPTURE_HOOKS}.
   */
  hooks?: ReadonlyArray<CaptureEventType>;
}

// ---------------------------------------------------------------------------
// toSaveInput — the pure host-event → SaveInput mapper
// ---------------------------------------------------------------------------

/**
 * Project a host-neutral {@link CaptureEvent} into a {@link SaveInput} ready for
 * `MemoryEngine.save` / the `memory_save` MCP tool, OR return `null` when the
 * policy says to skip this event (a noisy hook the user did not opt into, or an
 * event with no usable content).
 *
 * The mapper is PURE: it reads no environment, holds no secrets, performs NO I/O
 * and NO LLM call (capture is always local + free). It applies the
 * opinionated defaults from spec §5:
 *   • only the policy's `hooks` are captured (default: Stop + UserPromptSubmit);
 *   • content is built from the event's payload fields (summary / prompt / a
 *     compact tool-call description);
 *   • `type` is inferred lightly (a decision-shaped prompt → `'decision'`; a
 *     tool hook → `'workflow'`; otherwise `'fact'`) — a heuristic the user can
 *     override by editing the saved row;
 *   • `files` is pulled best-effort from a tool input's `file_path`;
 *   • `sessionId` is forwarded when present.
 *
 * Returning `null` is the documented "skip" signal — the caller (a capture
 * command) MUST NOT treat it as an error; it is the policy working as intended.
 *
 * @param event  The host-neutral capture event.
 * @param policy Capture policy (defaults to {@link DEFAULT_CAPTURE_POLICY}).
 * @returns The {@link SaveInput}, or `null` to skip.
 */
export function toSaveInput(
  event: CaptureEvent,
  policy: CapturePolicy = DEFAULT_CAPTURE_POLICY,
): SaveInput | null {
  const allowed = policy.hooks ?? DEFAULT_CAPTURE_HOOKS;
  // Open-enum match: an unknown hook name is captured only when the policy
  // explicitly lists it (so a stray host event never sneaks past the policy).
  if (!allowed.includes(event.event_type)) return null;

  const content = buildContent(event);
  // No usable text ⇒ nothing worth persisting. Trim so a whitespace-only
  // summary/prompt is treated as empty (R3: keep memory signal-rich).
  if (content === null || content.trim().length === 0) return null;

  const input: SaveInput = {
    content,
    type: inferType(event),
    sessionId: event.sessionId ?? undefined,
  };
  const files = extractFiles(event.payload);
  if (files.length > 0) input.files = files;
  return input;
}

// ---------------------------------------------------------------------------
// Pure content / type / file helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Build the observation `content` for an event from its payload, or `null` when
 * the payload carries nothing persistable. Per hook:
 *   • `Stop` → `payload.summary` (a session-end summary); null when absent.
 *   • `UserPromptSubmit` → `payload.prompt`; null when absent.
 *   • tool hooks (`PreToolUse` / `PostToolUse`, or any `toolName`-bearing
 *     event) → a compact {@link describeToolCall} line.
 * Pure.
 */
export function buildContent(event: CaptureEvent): string | null {
  const { event_type, payload } = event;
  // Named hooks have a primary field (Stop → summary, UserPromptSubmit → prompt).
  if (event_type === 'Stop') {
    return payload.summary ?? null;
  }
  if (event_type === 'UserPromptSubmit') {
    return payload.prompt ?? null;
  }
  // Tool hooks (PreToolUse / PostToolUse) + any host-defined hook: prefer a
  // derived `summary` or a `prompt` when the host shipped one (so a hook like
  // SessionEnd that carries a summary is captured without special-casing),
  // then fall back to a compact {@link describeToolCall} for tool-bearing
  // events. describeToolCall returns null when there is nothing to describe.
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.prompt === 'string') return payload.prompt;
  return describeToolCall(payload);
}

/**
 * Render a compact one-line description of a tool call for memory content, e.g.
 * `"Ran Bash: npm test"` or `"Edited src/foo.ts"`. Returns `null` when the
 * payload carries neither a toolName nor a toolInput. Pure + best-effort — it
 * never throws on an unexpected toolInput shape (it renders what it can).
 */
export function describeToolCall(payload: CapturePayload): string | null {
  const { toolName, toolInput } = payload;
  // Try to surface the load-bearing field of common tools.
  const cmd = stringField(toolInput, 'command');
  const filePath = stringField(toolInput, 'file_path');
  const pattern = stringField(toolInput, 'pattern');

  if (toolName !== undefined) {
    if (cmd !== null) return `Ran ${toolName}: ${cmd}`;
    if (filePath !== null) {
      // Write tools mutate the file; everything else is a read-style op on it.
      // `${toolName}: ${filePath}` generalizes cleanly (Read/Grep/Glob …).
      return isWriteTool(toolName) ? `Edited ${filePath}` : `${toolName}: ${filePath}`;
    }
    if (pattern !== null) return `${toolName} /${pattern}/`;
    return `Used ${toolName}`;
  }
  // No toolName — describe the input object best-effort, else nothing.
  if (cmd !== null) return `Ran command: ${cmd}`;
  if (filePath !== null) return `Touched ${filePath}`;
  return null;
}

/**
 * Light type inference for a captured event (a heuristic — the user can override
 * by editing the saved row; no LLM is involved). Decision-shaped prompts
 * → `'decision'`; tool hooks → `'workflow'`; otherwise `'fact'` (the engine's
 * default type). Pure.
 */
export function inferType(event: CaptureEvent): MemoryType {
  if (event.event_type === 'UserPromptSubmit' && event.payload.prompt !== undefined) {
    return looksDecisionShaped(event.payload.prompt) ? 'decision' : 'fact';
  }
  if (event.event_type === 'PreToolUse' || event.event_type === 'PostToolUse') {
    return 'workflow';
  }
  if (event.event_type === 'Stop') {
    return 'workflow';
  }
  return 'fact';
}

/**
 * Extract repo-relative file paths from a tool input best-effort: the
 * `file_path` field (Edit / Write / Read) when present. Returns `[]` when none.
 * Pure; never throws on a non-object toolInput.
 */
export function extractFiles(payload: CapturePayload): string[] {
  const filePath = stringField(payload.toolInput, 'file_path');
  return filePath !== null ? [filePath] : [];
}

/**
 * The memory `source` provenance for a captured event: `'auto:<hook>'` (e.g.
 * `'auto:stop'`, `'auto:posttooluse'`), lowercased so the bucket name is a
 * stable identifier. Exported for a dedicated `noir memory capture` CLI (S9)
 * that persists an event OUTSIDE the `memory_save` envelope and wants to tag
 * provenance — the MCP `memory_save` path itself records `source:'explicit'`
 * (SaveInput carries no source field by design).
 */
export function captureSource(eventType: CaptureEventType): MemorySource {
  return `auto:${String(eventType).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/** Words that mark a prompt as decision-shaped (heuristic for `type:'decision'`). */
const DECISION_CUES = [
  'decided',
  'decision',
  'should',
  'let’s',
  "let's",
  'going with',
  'use ',
  'adopt',
  'convention',
  'rule:',
  'always ',
  'never ',
] as const;

/** True when a prompt reads like a decision / convention statement. Pure. */
function looksDecisionShaped(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return DECISION_CUES.some((cue) => lower.includes(cue));
}

/** Tool names that mutate files (→ "Edited"); others read (→ "Read … on …"). */
function isWriteTool(toolName: string): boolean {
  const t = toolName.toLowerCase();
  return t === 'edit' || t === 'write' || t === 'multiedit' || t === 'notebookedit';
}

/**
 * Read a string field off an unknown `obj` (a tool input), safely. Returns
 * `null` when `obj` is not an object, the field is absent, or the field is not a
 * string. The pattern that keeps `noUncheckedIndexedAccess` + `unknown` happy
 * without a value-level `zod` parse (capture is best-effort, not validated).
 */
function stringField(obj: unknown, field: string): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const val = rec[field];
  return typeof val === 'string' ? val : null;
}
