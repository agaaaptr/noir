// Legacy module path. The doctor implementation moved to `./commands/doctor.js`
// (S9); this file remains as a re-export shim so `./doctor.js` (used by
// index.ts and historical imports) keeps resolving. New code should import from
// `./commands/doctor.js`.
export { type DoctorOptions, doctor } from './commands/doctor.js';
