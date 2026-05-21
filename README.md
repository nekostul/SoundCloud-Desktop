<p align="center">
<a href="https://github.com/nekostul/SoundCloud-Desktop/releases/latest">
<img src="https://raw.githubusercontent.com/zxcloli666/SoundCloud-Desktop/legacy/icons/appLogo.png" width="180px" style="border-radius: 50%;" />
</a>
</p>

<h1 align="center">
<a href="https://github.com/nekostul/SoundCloud-Desktop">
SoundCloud Desktop
</a>
</h1>

<p align="center">
<b>Кастомный SoundCloud Desktop-клиент для Windows, macOS и Linux</b><br>
Без рекламы · Новый fullscreen для текстов · SoundWave · Улучшенный desktop UX
</p>

<p align="center">
<a href="https://github.com/nekostul/SoundCloud-Desktop/releases/latest">
<img src="https://img.shields.io/github/v/release/nekostul/SoundCloud-Desktop?style=for-the-badge&logo=github&color=FF5500&label=VERSION" alt="Version"/>
</a>
<a href="https://github.com/nekostul/SoundCloud-Desktop/stargazers">
<img src="https://img.shields.io/github/stars/nekostul/SoundCloud-Desktop?style=for-the-badge&logo=github&color=FF5500&label=Stars" alt="Stars"/>
</a>
<a href="https://github.com/zxcloli666/SoundCloud-Desktop/blob/main/LICENSE">
<img src="https://img.shields.io/badge/License-MIT-FF5500?style=for-the-badge" alt="License"/>
</a>
</p>

<p align="center">
<a href="https://github.com/nekostul/SoundCloud-Desktop/releases/latest">
<img src="https://img.shields.io/badge/Скачать-Последнюю_Версию-FF5500?style=for-the-badge" alt="Download"/>
</a>
</p>

---

# Что это?

**SoundCloud Desktop** — кастомный desktop-клиент для SoundCloud с полностью переработанным fullscreen-режимом для текстов, mini-player, SoundWave-рекомендациями, улучшенными страницами артистов и нативной оболочкой на **Tauri 2**.

В репозитории лежат две основные части:
- **`/desktop`** — desktop-приложение на **Tauri 2 + React 19 + Vite**
- **`/backend`** — локальный BFF на **NestJS 11 + TypeORM + SQL.js/SQLite**

---

# Особенности

## Fullscreen lyrics и mini-player

- новый fullscreen UI для текстов
- cinematic lyrics и ручной поиск текста
- сохранение состояния fullscreen между переключениями треков
- плавные переходы между artwork, lyrics и mini-player

---

## SoundWave

- улучшенные рекомендации и более непрерывная wave-очередь
- быстрый запуск Wave с артистов и плейлистов
- режимы похожих и более разнообразных рекомендаций
- фильтры по языкам и скрытие лайкнутых треков

---

## Обновлённые страницы артистов и UI

- редизайн страниц артистов
- похожие исполнители и внешние ссылки в профиле
- новые контекстные меню
- новый экран запуска и более аккуратный desktop UI

---

## Диагностика медиасоединения и proxy

- встроенная проверка доступности SoundCloud CDN
- помощник для проблем со стримами, artwork и waveform
- отдельные proxy-настройки именно для медиатрафика

---

## Playback

- fullscreen lyrics
- waveform и artwork-интеграция в плеере
- пресеты скорости: slowed / default / speed up
- улучшенная плавность прогресса и переключения треков

---

## Работа в России

Приложение может работать без дополнительных программ, но для части медиаконтента, artwork и waveform может понадобиться VPN или proxy. Для этого в приложении есть встроенная диагностика медиасоединения и отдельные proxy-настройки для медиатрафика.

---

## Авторизация через SoundCloud API

Для входа нужен собственный `Client ID` и `Client Secret` от SoundCloud OAuth app.

Создать приложение можно в [SoundCloud Developers](https://soundcloud.com/you/apps).  
Для OAuth app используйте redirect URI:

```text
https://sc-auth-redirect.web.app/oauth/callback
```

---

## Нативное приложение

Вместо Electron используется **Tauri 2 (Rust)**:

- меньше вес приложения
- ниже потребление памяти
- быстрее запуск
- нативная кроссплатформенная сборка

---

# Скачать

Последний релиз:

https://github.com/nekostul/SoundCloud-Desktop/releases/latest

Публикуются сборки для:
- **Windows**: `.exe`, `.msi`
- **macOS**: `.dmg`, `.app.tar.gz`
- **Linux**: `.AppImage`, `.deb`, `.rpm`, `.flatpak`

---

# Скриншоты

![fullscreen](https://s10.iimage.su/s/13/g9818J2xef9z7bB4g8ziX86HN2jZeVmkNiKe92azh.png)

![lyrics](https://s10.iimage.su/s/13/gSCkiZtxCh7JXDV9djGaOgHHBz4R5VH9wKYZauWEf.png)

![player](https://s10.iimage.su/s/13/gfG4bmxxbYkzzu8slFSIPlIXCciplg6JcQreUyOF4.png)

---

# Сборка из исходников

## Требования

- Node.js 22+
- pnpm
- Rust stable

---

## Desktop app

```bash
git clone https://github.com/nekostul/SoundCloud-Desktop.git
cd SoundCloud-Desktop/desktop
pnpm install
pnpm tauri dev
```

---

## Backend

Если нужно отдельно запустить локальный BFF:

```bash
cd backend
pnpm install
pnpm start:dev
```

Отдельную базу вручную поднимать не нужно: backend использует локальный SQLite-файл через `SQL.js`.

Подробнее: [backend/README.md](./backend/README.md)

---

## Production build

```bash
cd desktop
pnpm tauri build
```

---

# Стек

| Компонент | Технология |
| ---------- | ---------- |
| Desktop app | Tauri 2 |
| Frontend | React 19 |
| Build Tool | Vite 7 |
| Styling | Tailwind CSS 4 |
| State | Zustand |
| UI | Radix UI |
| Native layer | Rust |
| Backend | NestJS 11 |
| Data layer | TypeORM |
| Local storage | SQL.js / SQLite file |

---

# Лицензия

MIT License.

SoundCloud является торговой маркой SoundCloud Ltd.

Этот проект не аффилирован с SoundCloud.

---

<p align="center">
<code>soundcloud desktop</code> ·
<code>soundcloud windows</code> ·
<code>soundcloud macos</code> ·
<code>soundcloud linux</code> ·
<code>soundcloud россия</code> ·
<code>soundcloud desktop app</code> ·
<code>soundcloud fullscreen lyrics</code> ·
<code>soundcloud tauri</code>
</p>
