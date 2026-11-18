# Changelog

## 0.2.0

- New toolsets: `groups` (mail groups and members), `contacts` (shared contacts and folders, incl. folder tree), `org` (organization and domains), `security` (domain allow/block lists, quarantine), `audit` (audit log query) and opt-in `login` (passwordless login links, excluded from the default toolsets).
- `users`: new `check_shared_access` tool.
- `ALIMAIL_TOOLSETS` now defaults to every toolset except `login`.
- `onboard_employee` / `offboard_employee` prompts accept mail groups to join / leave when the `groups` toolset is enabled.
- GitHub Actions workflow that tests and builds multi-arch (amd64/arm64) Docker images and publishes them to `ghcr.io/mfc-open/alimail-admin-mcp`.
- Published to npm as `@mfc-open/alimail-admin-mcp` (run with `npx -y @mfc-open/alimail-admin-mcp`); GitHub Actions workflow publishes on `v*` tags via Trusted Publishing with provenance.

## 0.1.0

- Initial release.
- `users` toolset (18 tools) and `departments` toolset (9 tools) over the Alibaba Mail OpenAPI.
- Read-only by default; two-step confirmation for destructive operations; domain allow-list; audit log with redaction.
- API client with token caching, rate limiting, retry/backoff and normalized errors.
- stdio and stateless Streamable HTTP transports (Host validation, optional bearer token).
- Resources (`alimail://departments/tree`, `alimail://users/{email}`) and prompts (`onboard_employee`, `offboard_employee`).
- Multi-stage Dockerfile and docker-compose example.
