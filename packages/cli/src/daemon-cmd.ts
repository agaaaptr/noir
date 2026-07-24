// Legacy module path. The daemon command implementations moved to
// `./commands/daemon.js` (S9 t6) alongside `status`/`restart`; this file
// remains as a re-export shim so any external import of `./daemon-cmd.js`
// keeps resolving. New code should import from `./commands/daemon.js`.
export {
  type DaemonOptions,
  type DaemonStartOptions,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
} from './commands/daemon.js';
