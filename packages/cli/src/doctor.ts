import { pidAlive, readDaemonRecord } from '@noir-ai/daemon';

export async function doctor(): Promise<void> {
  const lines: string[] = [];
  lines.push(`node: ${process.version}`);
  lines.push(`platform: ${process.platform}`);
  const rec = readDaemonRecord();
  if (rec) {
    lines.push(`daemon record: pid=${rec.pid} port=${rec.port} alive=${pidAlive(rec.pid)}`);
  } else {
    lines.push('daemon record: none');
  }
  process.stderr.write(`noir doctor\n${lines.join('\n')}\n`);
}
