# Security Policy

## Supported version

Security fixes currently target the latest 0.2.x release. This is an alpha generator; generated applications require their own security review before production use.

## Reporting

Do not open a public issue for a suspected vulnerability. Send a private report to the repository owner with the affected version, reproduction, impact, and suggested remediation. The project will acknowledge a report within seven days and coordinate disclosure after a fix is available.

Never include live credentials or customer-generated repositories in a report. Use disposable fixtures.

## Security boundary

The compiler does not need a SaaS account or network access to generate code. MCP filesystem access is restricted by `BACKENDGEN_ALLOWED_ROOTS`; those roots are trusted operator configuration. Generated applications do not ship production secrets. Operators remain responsible for dependency updates, secret management, PostgreSQL hardening, authorization policy, TLS, backups, and deployment configuration.
