// C1 t10 — offline structural lint for the release/CI workflows.
//
// The installer smoke test (ci.yml `install-smoke` job) and the release
// checksum/attestation steps run ONLY in CI — they are online, never in the
// unit suite (global constraint). But a YAML typo in those steps would only
// surface when a push/PR triggers CI, tens of minutes late. This test lints
// the structural invariants of the two workflow files OFFLINE so a regression
// (dropped Windows matrix, missing attestation step, wrong action version)
// fails locally + in the offline `pnpm test` gate, immediately.
//
// It is deliberately stdlib-only (no `yaml` parser dep) — it asserts the
// specific strings/structure that matter, not full YAML well-formedness
// (actions/checkout + the GH runner parse the YAML for real in CI).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Walk up from this test file to the nearest dir carrying pnpm-workspace.yaml
 *  (the monorepo root). Falls back to `process.cwd()` when not found (e.g. a
 *  weird harness), but in this repo it always resolves to the checkout root. */
function repoRoot(): string {
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(here, 'pnpm-workspace.yaml'))) return here;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return resolve(); // cwd fallback
}

function readWorkflow(name: string): string {
  const p = join(repoRoot(), '.github', 'workflows', name);
  expect(existsSync(p), `workflow file exists: ${name}`).toBe(true);
  return readFileSync(p, 'utf8');
}

describe('release pipeline workflows (offline structural lint)', () => {
  describe('.github/workflows/ci.yml', () => {
    const yaml = readWorkflow('ci.yml');

    it('runs the verify matrix on ubuntu, macos, AND windows', () => {
      // The verify job's matrix is the first `os: [...]` block in the file.
      // Extract just that block so the install-smoke matrix (which also lists
      // the three OSes) can't satisfy this assertion by accident.
      const verifyBlock = yaml.split('install-smoke')[0] ?? '';
      const osMatch = verifyBlock.match(/os:\s*\[([^\]]+)\]/);
      expect(osMatch, 'verify matrix has an os: [...] list').not.toBeNull();
      const osList = osMatch?.[1] ?? '';
      expect(osList).toContain('ubuntu-latest');
      expect(osList).toContain('macos-latest');
      expect(osList).toContain('windows-latest');
    });

    it('does not fail-fast the verify matrix (one OS flake must not abort the others)', () => {
      const verifyBlock = yaml.split('install-smoke')[0] ?? '';
      expect(verifyBlock).toContain('fail-fast: false');
    });

    it('declares the install-smoke job and gates it on verify', () => {
      expect(yaml).toMatch(/\n\s*install-smoke:/);
      expect(yaml).toContain('needs: verify');
    });

    it('install-smoke runs the posix installer on non-Windows', () => {
      expect(yaml).toContain('bash scripts/install.sh');
    });

    it('install-smoke runs the PowerShell installer on Windows', () => {
      expect(yaml).toContain('powershell -ExecutionPolicy Bypass -File scripts/install.ps1');
    });

    it('install-smoke asserts both noir --version and noir doctor', () => {
      const smokeBlock = yaml.split('install-smoke')[1] ?? '';
      expect(smokeBlock).toContain('noir --version');
      expect(smokeBlock).toContain('noir doctor');
    });
  });

  describe('.github/workflows/release.yml', () => {
    const yaml = readWorkflow('release.yml');

    it('declares the permissions required for npm provenance + artifact attestations', () => {
      // id-token (OIDC for Sigstore + npm Trusted Publishing), contents
      // (release create + registry push), attestations (persist attestations).
      expect(yaml).toContain('id-token: write');
      expect(yaml).toContain('contents: write');
      expect(yaml).toContain('attestations: write');
    });

    it('generates a SHA256SUMS for the installers', () => {
      expect(yaml).toMatch(/shasum -a 256/);
      expect(yaml.toLowerCase()).toContain('sha256sums');
    });

    it('attests the installers via actions/attest-build-provenance', () => {
      // The action is the documented mechanism (not the gh CLI, which would
      // also need a token). v3+ accepts a multi-path subject-path list.
      expect(yaml).toContain('actions/attest-build-provenance@v');
      expect(yaml).toContain('subject-path:');
    });

    it('attests all three subjects (install.sh, install.ps1, SHA256SUMS)', () => {
      // The attestation must bind the checksums file too, otherwise a tampered
      // installer+checksum pair would verify cleanly against itself. The three
      // subjects are listed under the `subject-path:` block of the attestation step.
      const subjectMatch = yaml.match(/subject-path:\s*\|\s*\n((?:\s+-?\s*[^\n]+\n)+)/);
      expect(subjectMatch, 'subject-path: |- block with entries exists').not.toBeNull();
      const subjectBlock = subjectMatch?.[1] ?? '';
      expect(subjectBlock).toContain('install.sh');
      expect(subjectBlock).toContain('install.ps1');
      expect(subjectBlock.toLowerCase()).toContain('sha256sums');
    });

    it('attaches the installer assets to the GitHub Release', () => {
      // softprops/action-gh-release is used twice: once to create the release
      // (with body), once to append the installer assets. The attach step
      // lists the three files under `files:`.
      expect(yaml).toContain('softprops/action-gh-release@v2');
      // The attach step must come AFTER the release-create step so the release
      // body/name aren't clobbered by a body-less attach.
      const createIdx = yaml.indexOf('Create GitHub Release');
      const attachIdx = yaml.indexOf('Attach installer assets to release');
      expect(createIdx, 'Create GitHub Release step exists').toBeGreaterThan(-1);
      expect(attachIdx, 'attach step exists').toBeGreaterThan(-1);
      expect(attachIdx, 'attach step runs after release-create').toBeGreaterThan(createIdx);
    });
  });
});
