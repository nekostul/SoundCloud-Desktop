# SoundCloud Desktop Backend

Локальный BFF для SoundCloud Desktop.

Что делает backend:
- ведёт официальный SoundCloud OAuth flow
- проксирует запросы к `api.soundcloud.com`
- резолвит transcoding/stream URL для текущего playback pipeline
- хранит sessions, local likes, OAuth apps и listening history в локальном SQLite-файле

PostgreSQL больше не нужен. Docker для базы тоже не нужен.

## Требования

- Node.js 22+
- `corepack` / `pnpm`
- SoundCloud OAuth app с redirect URI:

```text
http://localhost:3000/auth/callback
```

## Настройка

Скопируйте пример:

```bash
cp .env.example .env
```

Минимальный `.env`:

```env
SOUNDCLOUD_CLIENT_ID=your_client_id
SOUNDCLOUD_CLIENT_SECRET=your_client_secret
SOUNDCLOUD_REDIRECT_URI=http://localhost:3000/auth/callback
SOUNDCLOUD_ACCESS_TOKEN=

DATABASE_PATH=./data/soundcloud-desktop.sqlite

PORT=3000
```

`DATABASE_PATH` указывает на локальный SQLite database file. Если файл не существует, backend создаст его сам.

## Локальный запуск

```bash
pnpm install
pnpm start:dev
```

Или production-like запуск:

```bash
pnpm build
pnpm start:prod
```

Backend поднимается на:

```text
http://localhost:3000
```

## Быстрый запуск под Windows

```bat
start-local-api.bat
```

Скрипт:
- поставит зависимости, если их ещё нет
- соберёт backend
- запустит локальный сервер без Docker и без PostgreSQL

Если desktop app уже установлен локально:

```bat
start-local-stack-and-app.bat
```

## Docker

Docker больше не нужен для базы, но при желании backend можно поднять в контейнере:

```bash
docker compose up app
```

Или dev-режим:

```bash
docker compose up app-dev
```

SQLite-файл будет храниться в примонтированной папке `./data`.

## Хранилище

SQLite теперь хранит:
- OAuth sessions
- session persistence между перезапусками
- local likes
- listening history
- сохранённые OAuth apps

Это не меняет playback pipeline, HLS handling, stream proxy logic backend-а или OAuth архитектуру приложения.

## Полезные URL

- `http://localhost:3000/health`
- `http://localhost:3000/api`
- `http://localhost:3000/openapi.json`

## Проверка

После запуска:
1. Откройте desktop app.
2. Авторизуйтесь через SoundCloud.
3. Убедитесь, что появился файл из `DATABASE_PATH`.
4. Перезапустите backend и проверьте, что session persistence сохранилась.
