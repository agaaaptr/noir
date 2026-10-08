# Final Comprehensive Verification & Publish Gate

> **Purpose:** the mandatory final gate, run to completion before every beta and stable
> publish. Verification is COMPLETE only when a final rescan is clean and zero findings
> remain. Publish is a later, separate step.

Do not treat verification as finished just because the implementation looks correct or the
first pass found no problems. Run **end-to-end verification** over the entire result:
source code, structure, files and directories, configuration, dependencies,
imports/references, documentation, research/reference material, generated files,
commands/workflows, tests, build, lint, validation, and every change made during the work.

Use this cycle:

> **SCAN → IDENTIFY → FIX → RESCAN → VERIFY → REPEAT**

Verification may only be declared **COMPLETE** when a final rescan is genuinely clean and
no issue remains.

## 1. Validate Scope, Plan, Requirements, and Implementation

Re-review the full scope, plan, research, references, requirements, and intended behavior
that were agreed. Ensure:

- The full scope is covered.
- The full plan is implemented.
- Every task is finished.
- No requirement was missed.
- No requirement detail was only partially implemented.
- There are no implementation gaps.
- The actual implementation matches the research and references.
- The implementation follows the intended behavior.
- The implementation follows existing patterns and conventions.
- Nothing that should have changed still uses the old implementation.
- There are no out-of-scope changes.
- There are no unnecessary changes without a clear technical reason.
- No temporary workaround remains in place.

Do not only check whether the code structure looks right. Actually validate the behavior
and the relationships between components.

## 2. Validate Files, Directories, Paths, and Project Structure

Audit every file and directory that the work touches or references. Check for: incorrect
path, broken path, missing path, stale path, broken import, broken reference, missing
file, missing directory, duplicate file, duplicate configuration, duplicate logic,
duplicate content, incorrect filename, incorrect location, corrupted file, overwritten
file, incomplete generated file, and stale file.

Ensure:

- Every file is in the correct location.
- Every name follows the existing convention.
- Every import/reference points at the correct target.
- No reference points at a file or directory that was moved or deleted.
- No temporary development file was left behind.
- No unnecessary backup file was left behind.
- No generated artifact that should not be in the repository was committed.
- No file produced by a write/generate step has wrong or incomplete content.
- No configuration is duplicated or conflicting.

Also audit dependencies and inter-file linkages so the whole project stays consistent.

## 3. Validate Configuration and Dependencies

Review every relevant piece of configuration: package/dependency, version, configuration
file, environment/reference, scripts, build configuration, tooling configuration, plugin
configuration, command, import, export, and integration point. Ensure:

- There are no unnecessary dependencies.
- There are no missing dependencies.
- There is no stale or conflicting configuration.
- No reference points at a package, command, path, or API that is no longer used.
- No new configuration was added when the existing configuration already covers it.
- Every configuration follows the existing project pattern.

Do not create new configuration when the existing configuration can already be used.

## 4. Validate All Documentation

Audit **ALL project documentation**, not only the files that were created or changed:
README, guides, references, examples, usage documentation, configuration documentation,
command documentation, API documentation, workflow documentation, skill documentation,
internal documentation, and cross-references between documents.

Ensure all documentation is accurate, relevant, complete, consistent, up to date, and
matches the actual implementation. Find and fix: stale information, stale path, stale
command, stale API, stale naming, stale configuration, stale workflow, broken link,
broken reference, misleading information, ambiguous information, contradictory
information, incomplete information, technically incorrect information, and examples that
no longer apply.

Validate in particular: every command is still valid, every path is still valid, every
example still works, every configuration example matches the actual implementation, every
workflow matches the actual behavior, no document claims a feature that is not yet
implemented, no document describes the old implementation, no two documents give
different instructions for the same thing, and no important information is missing.

If the implementation changed but the documentation was not updated, **update the
documentation first.** The final documentation must be the single source of truth for the
current implementation.

## 5. Validate References and Cross-References

Audit every reference the project uses: file references, directory/path references,
internal documentation, external documentation, research references, configuration
references, command references, skill references, dependency references, API/reference
names, examples, and cross-references between files.

For every reference, ensure it is valid, accessible, relevant, current, non-stale,
non-misleading, non-contradictory, and consistent with the current implementation. If a
reference is no longer valid, do not only note it — fix or update it.

## 6. Audit Remaining Work and Technical Debt

Ensure no work was left behind. Search explicitly for: TODO, FIXME, placeholder, temporary
implementation, workaround, incomplete implementation, commented-out code that should have
been deleted, dead code, obsolete code, unnecessary complexity, known issues, unfinished
cleanup, and technical debt introduced by this change.

Do not treat an issue as acceptable just because it is minor. If a finding is a real
problem, fix it. Do not leave an issue just because the impact is small, it is not a
blocker, it does not show on the happy path, or it is easy to fix later. The verification
target is a clean implementation, not an implementation that merely works.

## 7. Run Full Automated Verification

After the manual review, run every available and relevant verification: lint, build, test,
type checking, static analysis, validation, format check, dependency validation,
configuration validation, documentation/reference validation, and any other relevant
check. Use the full available verification, not a subset you judge sufficient.

Target: **ALL RELEVANT CHECKS = GREEN / PASS**. There must be no lint error, build error,
test failure, type error, validation error, broken reference, broken path, stale content,
documentation inconsistency, or known issue. Investigate every warning and decide whether
it indicates a real problem; if it does, fix it before verification finishes.

## 8. Mandatory Iterative Verification

If any problem is found, follow this sequence: (1) **IDENTIFY** the root cause, the
affected files/components/documentation/references, and potential side effects;
(2) **FIX** the root cause thoroughly, not just the symptom; (3) **RESCAN** the fixed area
along with the related dependencies, references, documentation, and affected integration
points; (4) **RE-RUN VERIFICATION** for the relevant checks; (5) **REGRESSION CHECK** —
confirm the fix causes no regression, does not break existing behavior, creates no
duplication, no stale reference, no unnecessary new file or configuration, and introduces
no new issue; (6) **REPEAT** until there are no more findings.

## 9. Final Verification Gate

Verification is NOT COMPLETE if even one finding remains. It may only be declared
COMPLETE / CLEAN / GREEN when every condition below holds:

- [ ] Scope is covered.
- [ ] Plan is executed.
- [ ] All tasks are complete.
- [ ] All requirements are met.
- [ ] There are no implementation gaps.
- [ ] There are no out-of-scope changes.
- [ ] There are no incorrect paths.
- [ ] There are no broken paths.
- [ ] There are no missing files/directories.
- [ ] There are no broken imports/references.
- [ ] There is no unnecessary duplication.
- [ ] There are no generated-file issues.
- [ ] There are no temporary artifacts.
- [ ] Configuration is valid and consistent.
- [ ] Dependencies are valid and necessary.
- [ ] There are no stale references.
- [ ] There is no stale documentation.
- [ ] All documentation is accurate.
- [ ] All documentation is up to date.
- [ ] There is no misleading information.
- [ ] There is no contradictory information.
- [ ] There is no incomplete information.
- [ ] There are no broken links/references.
- [ ] There are no unresolved TODO/FIXME items.
- [ ] There are no placeholders.
- [ ] There are no incomplete implementations.
- [ ] There are no temporary workarounds.
- [ ] There are no known issues.
- [ ] There is no unnecessary technical debt.
- [ ] Lint PASS.
- [ ] Build PASS.
- [ ] Test PASS.
- [ ] Type checking PASS.
- [ ] Static analysis PASS (if available).
- [ ] Validation PASS.
- [ ] There are no warnings that indicate a real problem.
- [ ] There are no regressions.
- [ ] The final rescan is clean.
- [ ] Not even a minor finding remains.

If a single item above fails, verification is not finished.

## 10. Publish Gate

Do not publish before Final Verification is truly COMPLETE. If any issue, inconsistency,
stale reference, stale documentation, broken path, broken link, technical debt, failed
check, incomplete implementation, regression, or other finding remains, then
**STOP → FIX → RESCAN → VERIFY AGAIN**. Do not proceed to publish just because an issue
is considered minor or non-blocking.

Publish is only allowed after the final result is **SAFE + CLEAN + CONSISTENT + COMPLETE +
GREEN** with **ZERO OUTSTANDING FINDINGS**.

## 11. Publish Preparation

After Final Verification is declared COMPLETE, proceed to publish. Follow the existing
release process, workflow, naming convention, versioning convention, and package/release
structure. Use existing commands and tooling when available. Do not create a new workflow
or pattern without a strong reason, and do not make additional changes outside the publish
scope. Publish is the stage after verification, not part of verification.

The final verification output must clearly state: (1) verification status, (2) which
verification steps were run, (3) findings discovered, (4) fixes applied, (5) rescan
results, (6) lint/build/test/validation results, (7) whether any outstanding issue
remains, and (8) whether the project is **READY TO PUBLISH**.

If any outstanding issue remains, the status must be **NOT READY TO PUBLISH**. If all
verification is clean: **VERIFICATION COMPLETE — READY TO PUBLISH**.
