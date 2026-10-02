# Security

This is a personal, single-owner-per-account sharing service. Access to the hosted
instance is restricted by its identity provider; publication of source code does
not open enrollment on that instance.

Report suspected vulnerabilities privately to the repository owner's email in
Git author metadata. Include affected version and synthetic reproduction steps;
do not send tokens, private contexts or service-account files. Do not post an
exploit containing personal data to public issues. The maintainer will coordinate
fixes and disclosure; no response-time SLA is promised.

Run `pnpm audit`, `pnpm audit --prod`, `pnpm test`, `pnpm typecheck` and
`pnpm test:rules` before a release. CI also scans Git history and built web files
with Gitleaks. Review all advisories individually; do not suppress whole packages.

Only `dist`/installer artifacts and tracked source are distributable. Never
archive an entire working directory: ignored runtime files, Terraform state,
emulator logs and configuration may contain credentials. Scan current history,
refs, CI logs and release assets again before changing repository visibility.

The current installers are Windows unsigned and macOS ad-hoc signed, without
notarization. Public signed distribution requires separately provisioned signing
identities. This is not equivalent to a failure of application authentication.

See [data handling](docs/privacy.md), [self-hosting](docs/self-hosting.md), and the
[deployment procedure](docs/operations/deployment.md).
