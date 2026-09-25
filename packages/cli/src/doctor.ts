// Legacy module path. The doctor implementation moved to `./commands/doctor.js`;
// this file remains as a re-export shim so `./doctor.js` (used by
// index.ts and historical imports) keeps resolving. New code should import from
// `./commands/doctor.js`.
//
// It re-exports only what the public surface consumes (`doctor`) plus the
// output-hygiene constants and types the commands module re-exports, so the two
// lists cannot drift apart and no dead name is carried here.
export {
  doctor,
  HYGIENE_FINDING_CAP,
  HYGIENE_MAX_FILE_BYTES,
  HYGIENE_MAX_FILES,
  type HygieneScanFinding,
  type HygieneScanResult,
} from './commands/doctor.js';
