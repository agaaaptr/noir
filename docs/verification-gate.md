# Final Comprehensive Verification & Publish Gate

> **Purpose:** the mandatory final gate, run to completion before every beta and stable
> publish. Verification is COMPLETE only when a final rescan is clean and zero findings
> remain. Publish is a later, separate step.

Verification tidak boleh dianggap selesai hanya karena implementasi terlihat benar atau
pemeriksaan awal tidak menemukan masalah. Lakukan **end-to-end verification** terhadap
seluruh hasil implementasi: source code, structure, file dan directory, configuration,
dependency, import/reference, documentation, research/reference, generated files,
commands/workflow, test, build, lint, validation, dan seluruh perubahan yang dibuat.

Gunakan siklus:

> **SCAN → IDENTIFY → FIX → RESCAN → VERIFY → REPEAT**

Verification hanya boleh dinyatakan **COMPLETE** apabila final rescan benar-benar clean
dan tidak ada issue yang tersisa.

## 1. Validate Scope, Plan, Requirements, and Implementation

Review kembali seluruh scope, plan, research, reference, requirement, dan intended
behavior yang telah ditentukan. Pastikan:

- Seluruh scope sudah terpenuhi.
- Seluruh plan sudah diimplementasikan.
- Seluruh task sudah selesai.
- Tidak ada requirement yang terlewat.
- Tidak ada detail requirement yang hanya diimplementasikan sebagian.
- Tidak ada implementation gap.
- Implementasi aktual sesuai dengan hasil research dan reference.
- Implementasi mengikuti intended behavior.
- Implementasi mengikuti pattern dan convention existing.
- Tidak ada bagian yang seharusnya sudah diubah tetapi masih menggunakan implementation lama.
- Tidak ada perubahan yang out of scope.
- Tidak ada perubahan unnecessary tanpa alasan teknis yang jelas.
- Tidak ada workaround sementara yang masih tertinggal.

Jangan hanya memeriksa apakah struktur code terlihat benar. Validasi behavior dan
hubungan antar-komponen secara aktual.

## 2. Validate Files, Directories, Paths, and Project Structure

Audit seluruh file dan directory yang terdampak maupun yang direferensikan. Periksa:
incorrect path, broken path, missing path, stale path, broken import, broken reference,
missing file, missing directory, duplicate file, duplicate configuration, duplicate
logic, duplicate content, incorrect filename, incorrect location, corrupted file,
overwritten file, incomplete generated file, dan stale file.

Pastikan:

- Semua file berada pada lokasi yang benar.
- Semua naming mengikuti existing convention.
- Semua import/reference mengarah ke target yang benar.
- Tidak ada reference ke file atau directory yang sudah dipindahkan atau dihapus.
- Tidak ada file development sementara yang tertinggal.
- Tidak ada backup file yang tidak diperlukan.
- Tidak ada generated artifact yang seharusnya tidak berada di repository.
- Tidak ada file hasil proses tulis/generate yang content-nya salah atau incomplete.
- Tidak ada configuration yang terduplikasi atau conflicting.

Audit juga dependency dan linkage antar-file agar seluruh project tetap konsisten.

## 3. Validate Configuration and Dependencies

Review seluruh configuration yang berkaitan: package/dependency, version, configuration
file, environment/reference, scripts, build configuration, tooling configuration, plugin
configuration, command, import, export, dan integration point. Pastikan:

- Tidak ada dependency yang tidak diperlukan.
- Tidak ada dependency yang hilang.
- Tidak ada configuration yang stale atau conflicting.
- Tidak ada reference ke package, command, path, atau API yang sudah tidak digunakan.
- Tidak ada configuration baru yang sebenarnya tidak diperlukan karena existing sudah ada.
- Seluruh configuration mengikuti existing project pattern.

Jangan membuat configuration baru jika configuration existing masih dapat digunakan.

## 4. Validate All Documentation

Audit **SELURUH dokumentasi project**, bukan hanya yang baru dibuat atau diubah: README,
guides, references, examples, usage, configuration, command, API, workflow, skill,
internal documentation, dan cross-reference antar-dokumentasi.

Pastikan seluruh dokumentasi akurat, relevan, complete, consistent, up-to-date, dan
sesuai implementation aktual. Cari dan perbaiki: stale information, stale path, stale
command, stale API, stale naming, stale configuration, stale workflow, broken link,
broken reference, misleading information, ambiguous information, contradictory
information, incomplete information, technically incorrect information, dan example yang
sudah tidak sesuai.

Validasi khusus: semua command masih valid, semua path masih valid, semua example masih
dapat digunakan, semua configuration example sesuai implementation, semua workflow sesuai
behavior aktual, dokumentasi tidak mengklaim feature yang belum diimplementasikan,
dokumentasi tidak menjelaskan implementation lama, tidak ada dua dokumentasi yang memberi
instruksi berbeda untuk hal yang sama, dan informasi penting tidak hilang.

Jika implementation berubah tetapi documentation belum diperbarui, **update
documentation terlebih dahulu.** Documentation final harus menjadi single source of
truth untuk kondisi implementation saat ini.

## 5. Validate References and Cross-References

Audit seluruh reference: file reference, directory/path reference, internal documentation,
external documentation, research reference, configuration reference, command reference,
skill reference, dependency reference, API/reference name, examples, dan cross-reference
antar-file.

Untuk setiap reference, pastikan valid, accessible, relevant, current, non-stale,
non-misleading, non-contradictory, dan sesuai implementation saat ini. Jika menemukan
reference yang tidak valid, jangan hanya mencatatnya — perbaiki atau update.

## 6. Audit Remaining Work and Technical Debt

Pastikan tidak ada pekerjaan yang tertinggal. Cari secara eksplisit: TODO, FIXME,
placeholder, temporary implementation, workaround, incomplete implementation,
commented-out implementation yang seharusnya dihapus, dead code, obsolete code,
unnecessary complexity, known issue, cleanup yang belum selesai, dan technical debt dari
perubahan ini.

Jangan menganggap issue acceptable hanya karena minor. Jika suatu temuan adalah masalah,
fix it. Jangan meninggalkan issue hanya karena impact kecil, bukan blocker, tidak
terlihat pada happy path, atau mudah diperbaiki nanti. Target verification adalah clean
implementation, bukan implementation yang "cukup berjalan".

## 7. Run Full Automated Verification

Setelah manual review, jalankan seluruh verification yang tersedia: lint, build, test,
type checking, static analysis, validation, format check, dependency validation,
configuration validation, documentation/reference validation, dan verification lain yang
relevan. Gunakan full available verification, bukan subset.

Target: **ALL RELEVANT CHECKS = GREEN / PASS**. Tidak boleh ada lint error, build error,
test failure, type error, validation error, broken reference, broken path, stale content,
documentation inconsistency, atau known issue. Investigate setiap warning dan tentukan
apakah ia menunjukkan masalah nyata; jika ya, fix sebelum verification selesai.

## 8. Mandatory Iterative Verification

Jika menemukan masalah apa pun: (1) **IDENTIFY** root cause, affected files/components/
documentation/references, dan potential side effects; (2) **FIX** root cause secara
menyeluruh, bukan patch symptom; (3) **RESCAN** area yang diperbaiki beserta dependency,
reference, documentation, dan integration point yang terdampak; (4) **RE-RUN VERIFICATION**
yang relevan; (5) **REGRESSION CHECK** pastikan fix tidak merusak behavior existing,
tidak membuat duplicate/stale reference/file baru yang tak perlu, dan tidak menambah
issue baru; (6) **REPEAT** sampai tidak ada temuan lagi.

## 9. Final Verification Gate

Verification belum COMPLETE jika masih ada satu pun temuan. Hanya boleh dinyatakan
COMPLETE / CLEAN / GREEN jika seluruh kondisi berikut terpenuhi:

- [ ] Scope terpenuhi.
- [ ] Plan terlaksana.
- [ ] Semua task selesai.
- [ ] Semua requirement terpenuhi.
- [ ] Tidak ada implementation gap.
- [ ] Tidak ada out-of-scope change.
- [ ] Tidak ada incorrect path.
- [ ] Tidak ada broken path.
- [ ] Tidak ada missing file/directory.
- [ ] Tidak ada broken import/reference.
- [ ] Tidak ada unnecessary duplicate.
- [ ] Tidak ada generated-file issue.
- [ ] Tidak ada temporary artifact.
- [ ] Configuration valid dan konsisten.
- [ ] Dependency valid dan diperlukan.
- [ ] Tidak ada stale reference.
- [ ] Tidak ada stale documentation.
- [ ] Seluruh documentation akurat.
- [ ] Seluruh documentation up-to-date.
- [ ] Tidak ada misleading information.
- [ ] Tidak ada contradictory information.
- [ ] Tidak ada incomplete information.
- [ ] Tidak ada broken link/reference.
- [ ] Tidak ada TODO/FIXME yang seharusnya sudah diselesaikan.
- [ ] Tidak ada placeholder.
- [ ] Tidak ada incomplete implementation.
- [ ] Tidak ada workaround sementara.
- [ ] Tidak ada known issue.
- [ ] Tidak ada unnecessary technical debt.
- [ ] Lint PASS.
- [ ] Build PASS.
- [ ] Test PASS.
- [ ] Type checking PASS.
- [ ] Static analysis PASS jika tersedia.
- [ ] Validation PASS.
- [ ] Tidak ada warning yang menunjukkan masalah nyata.
- [ ] Tidak ada regression.
- [ ] Final rescan clean.
- [ ] Tidak ada temuan minor sekalipun.

Jika satu saja checklist di atas gagal, verification belum selesai.

## 10. Publish Gate

Jangan melakukan publish sebelum Final Verification benar-benar COMPLETE. Jika masih ada
issue, inconsistency, stale reference, stale documentation, broken path, broken link,
technical debt, failed check, incomplete implementation, regression, atau temuan lain,
maka **STOP → FIX → RESCAN → VERIFY AGAIN**. Jangan melanjutkan ke publish hanya karena
issue dianggap minor atau non-blocking.

Publish hanya diperbolehkan setelah hasil akhir **SAFE + CLEAN + CONSISTENT + COMPLETE +
GREEN** dan **ZERO OUTSTANDING FINDINGS**.

## 11. Publish Preparation

Setelah Final Verification dinyatakan COMPLETE, lanjut ke publish. Ikuti existing release
process, workflow, naming convention, versioning convention, dan package/release
structure. Gunakan existing command dan tooling jika tersedia. Jangan membuat workflow
atau pattern baru tanpa alasan yang kuat, dan jangan melakukan perubahan tambahan di luar
scope publish. Publish adalah tahap setelah verification, bukan bagian dari verification.

Final output verification harus menyatakan: (1) verification status, (2) verification yang
dijalankan, (3) temuan yang ditemukan, (4) fix yang dilakukan, (5) hasil rescan, (6) hasil
lint/build/test/validation, (7) apakah ada outstanding issue, (8) apakah project
**READY TO PUBLISH**.

Jika masih ada outstanding issue: **NOT READY TO PUBLISH**. Jika seluruh verification
clean: **VERIFICATION COMPLETE — READY TO PUBLISH**.
