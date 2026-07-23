import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';

export type Transport = 'stdio' | 'streamable-http';

export interface HostStatus {
  noir: string;
  project: { id: string; name: string };
  host: string;
  transport: Transport;
  daemon: boolean;
  pid?: number;
  uptimeSec?: number;
}

export interface StatusContext {
  transport: Transport;
  daemon: boolean;
  pid?: number;
  startedAt?: number;
}

export function buildStatus(project: ProjectInfo, ctx: StatusContext): HostStatus {
  const status: HostStatus = {
    noir: NOIR_VERSION,
    project: { id: project.id, name: project.name },
    host: project.config.host,
    transport: ctx.transport,
    daemon: ctx.daemon,
  };
  if (ctx.pid !== undefined) status.pid = ctx.pid;
  if (ctx.startedAt !== undefined) {
    status.uptimeSec = Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000));
  }
  return status;
}
