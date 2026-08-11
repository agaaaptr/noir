import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createEmbedFn, resolveEmbedderConfig } from '@noir-ai/context';
import { resolveMemoryConfig } from '@noir-ai/memory';
import { resolveModelConfig } from '@noir-ai/model';
import { buildContextEngine } from './context-seam.js';
import { buildIntegrationService } from './integration-seam.js';
import { buildMemoryEngine, resolveConsolidationCapability } from './memory-seam.js';
import { createNoirServer, type ServerContext } from './server.js';
import { openStoreForDaemon } from './store-seam.js';
import { buildWorkflowEngine, resolveGateConfig } from './workflow-seam.js';

export async function startStdioServer(ctx: ServerContext): Promise<void> {
  // The daemon is the single writer: open the store once for this stdio serve
  // lifecycle and hold it open for the life of the process (the transport
  // services requests after `connect` resolves, until stdin closes). If the
  // store can't be opened at all, omit it — `store_status` isn't
  // registered and host_status still works. Process exit reclaims the handle.
  const daemonStore = await openStoreForDaemon(ctx.project.id, ctx.project.root).catch(
    () => undefined,
  );
  // One engine per serve lifecycle, built from the same store handle. The
  // gate-config bridge (c4-surface-wiring S5) resolves the user's
  // `prd.mandatoryFor` override so it reaches the engine.
  const engine = daemonStore
    ? buildWorkflowEngine(
        daemonStore.store,
        ctx.project.root,
        ctx.project.id,
        resolveGateConfig(ctx.project.config),
      )
    : undefined;
  // The daemon owns ONE embedder. Resolve the config once (`resolveEmbedderConfig`
  // is the core→context bridge — no cycle) and materialize the `EmbedFn` once
  // (`createEmbedFn`); the same `EmbedFn` is handed to the memory engine below.
  // The context engine still takes the `EmbedderConfig` (its own contract) and
  // resolves its embedder internally from the SAME config — for `kind:'local'`
  // the ONNX pipeline is module-cached, so the two resolutions share one loaded
  // model (no duplicate download, no second native handle). The store's
  // `degraded` flag threads through so `context_status`/`memory_save` are honest
  // under a read-only (daemon-down) handle and writes short-circuit clearly.
  const embedderCfg = resolveEmbedderConfig(ctx.project.config.context);
  const embed = createEmbedFn(embedderCfg).embed;
  const context = daemonStore
    ? buildContextEngine(
        daemonStore.store,
        ctx.project.root,
        ctx.project.id,
        embedderCfg,
        daemonStore.degraded,
      )
    : undefined;
  // Consolidation is OPT-IN + provider-explicit (D5/D6 — NEVER a silent
  // paid call, the Agent-Memory anti-pattern §9). The master switch is the
  // user's `memory.consolidation.enabled`; only when it is true does the
  // model-derived provider+model even get considered. `resolveMemoryConfig` is
  // the pure core→memory bridge (no env inference, no cycle); resolved once and
  // passed to buildMemoryEngine so the engine's config reflects the user's
  // `memory:` consent exactly. The `memory_consolidate` tool is registered only
  // when the gate resolves; the engine's `consolidate` self-refuses otherwise.
  const modelCfg = resolveModelConfig(ctx.project.config.model);
  const resolvedMemory = resolveMemoryConfig(ctx.project.config.memory);
  const memoryConsolidation = resolveConsolidationCapability(resolvedMemory, modelCfg) !== null;
  const memory = daemonStore
    ? buildMemoryEngine(
        daemonStore.store,
        ctx.project.root,
        ctx.project.id,
        embed,
        modelCfg,
        daemonStore.degraded,
        resolvedMemory,
      )
    : undefined;
  // Integration service. Built once per serve lifecycle (no
  // store dependency) so `integrations_auth` works even under a read-only store.
  const integrations = buildIntegrationService(ctx.project.root, ctx.project.config.integrations);
  const server = createNoirServer({
    ...ctx,
    ...(daemonStore
      ? {
          store: daemonStore.store,
          dbPath: daemonStore.dbPath,
          storeDegraded: daemonStore.degraded,
        }
      : {}),
    ...(engine ? { engine } : {}),
    ...(context ? { context } : {}),
    ...(memory ? { memory, memoryConsolidation } : {}),
    ...(integrations ? { integrations } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
