# Security Policy

## Supported versions

Security fixes target the `main` branch and the latest production deployment. Older commits, forks, and self-hosted deployments are not maintained by the project.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub’s private vulnerability reporting form:

https://github.com/caseymanos/opensession/security/advisories/new

Include the affected commit or deployment, reproduction steps, expected impact, and any suggested mitigation. Avoid including real credentials, personal data, or tenant data.

We will acknowledge a report within two business days, keep the reporter informed while we validate and remediate it, and coordinate disclosure after a fix is available.

## Security boundaries

Reports are especially useful when they concern tenant or event isolation, authentication and session integrity, upload authorization or content handling, webhook or API-key trust boundaries, secret exposure, or bypasses of production feature gates.

Reports that only affect unsupported forks, require an already-compromised administrator account, or describe dependency findings without a reachable impact may be closed without a project advisory.

## Disclosure

Please allow a reasonable remediation window before public disclosure. We will credit reporters who want attribution and whose reports lead to a security fix.
