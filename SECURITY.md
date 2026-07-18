# Security Policy

## Supported version

Security fixes currently target the latest 0.2.x release. This is an alpha generator; generated applications require their own security review before production use.

## Reporting

Do not open a public issue for a suspected vulnerability. Send a private report to the repository owner with the affected version, reproduction, impact, and suggested remediation. The project will acknowledge a report within seven days and coordinate disclosure after a fix is available.

Never include live credentials or customer-generated repositories in a report. Use disposable fixtures.

## Security boundary

The compiler does not need a SaaS account or network access to generate code. MCP filesystem access is restricted by `BACKENDGEN_ALLOWED_ROOTS`; those roots are trusted operator configuration. Generated applications do not ship production secrets. Operators remain responsible for dependency updates, secret management, PostgreSQL hardening, authorization policy, TLS, backups, and deployment configuration.

`run_generated_tests` executes generated and custom project code. It verifies the
generation manifest and compiler-owned file hashes first, but configured allowed
roots and editable custom code remain trusted code-execution boundaries.

The latest generated-code review and remaining release risks are documented in
[docs/SECURITY_REVIEW_2026-07-18.md](docs/SECURITY_REVIEW_2026-07-18.md), which
partially supersedes [docs/SECURITY_REVIEW_2026-07-14.md](docs/SECURITY_REVIEW_2026-07-14.md).
The structural guarantees checked across deterministic generated repositories
are documented in
[docs/FUZZ_SECURITY_CONTRACT.md](docs/FUZZ_SECURITY_CONTRACT.md).
