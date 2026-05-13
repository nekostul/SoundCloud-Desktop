# Backend (NestJS BFF)

## Stack

- **NestJS 11** for the backend framework
- **TypeORM** with a local **SQLite** database file
- **pnpm** for package management
- **Biome** for linting and formatting

## Architecture

- **BFF pattern**: the backend proxies application requests to the official SoundCloud OAuth API.
- **Auth**: OAuth 2.1 + PKCE with persistent sessions stored in SQLite. Authentication uses the `x-session-id` header.
- **Stream proxy**: `GET /tracks/:id/stream?format=http_mp3_128` keeps the existing playback pipeline and forwards audio with Range support.
- **OpenAPI**: `/openapi.json`, Swagger UI at `/api`.
- **Modules**: auth, me, tracks, playlists, users, likes, reposts, resolve, health.

## Rules

- Use NestJS decorators for controllers and services.
- Use TypeORM repositories and query builder instead of raw SQL where practical.
- Use `class-validator` and `class-transformer` for DTO validation.
- Use `ConfigService` for configuration access inside services.
- Use `HttpModule` / axios for SoundCloud HTTP calls.
- Throw NestJS exceptions instead of returning manual error payloads with `200`.
- Keep the backend desktop-friendly: no PostgreSQL or Docker dependency is required for local runs.

## Checks

- `npx tsc --noEmit`
- `npx biome check`
