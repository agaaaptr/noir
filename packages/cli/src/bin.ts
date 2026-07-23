import { parseArgs } from 'node:util';
import { doctor } from './doctor.js';
import { init } from './init.js';
import { serve } from './serve.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'init') {
    const { values } = parseArgs({
      options: {
        transport: { type: 'string', default: 'stdio' },
        url: { type: 'string' },
      },
      args: argv.slice(1),
    });
    const transport = values.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    await init(process.cwd(), { transport, url: values.url });
    return;
  }

  if (cmd === 'mcp') {
    const sub = argv[1];
    if (sub !== 'serve') {
      process.stderr.write('Usage: noir mcp serve [--stdio]\n');
      process.exitCode = 2;
      return;
    }
    const { values } = parseArgs({
      options: { stdio: { type: 'boolean', default: false } },
      args: argv.slice(2),
    });
    await serve({ stdio: values.stdio });
    return;
  }

  if (cmd === 'daemon') {
    process.stderr.write('noir daemon start|stop arrives in Task 10.\n');
    process.exitCode = 0;
    return;
  }

  if (cmd === 'doctor') {
    await doctor();
    return;
  }

  process.stderr.write(
    'Noir — commands: init | mcp serve [--stdio] | daemon start|stop | doctor\n',
  );
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  process.stderr.write(`noir: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
