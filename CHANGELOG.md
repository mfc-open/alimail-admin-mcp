# Changelog

## 0.1.0

- Initial release.
- `users` toolset (18 tools) and `departments` toolset (9 tools) over the Alibaba Mail OpenAPI.
- Read-only by default; two-step confirmation for destructive operations; domain allow-list; audit log with redaction.
- API client with token caching, rate limiting, retry/backoff and normalized errors.
- stdio and stateless Streamable HTTP transports (Host validation, optional bearer token).
- Resources (`alimail://departments/tree`, `alimail://users/{email}`) and prompts (`onboard_employee`, `offboard_employee`).
- Multi-stage Dockerfile and docker-compose example.
