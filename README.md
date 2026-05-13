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
<b>Кастомный SoundCloud Desktop клиент для Windows</b><br>
Без рекламы · Без капчи · Без цензуры · Доступно в России
</p>

<p align="center">
<a href="https://github.com/nekostul/SoundCloud-Desktop/releases/latest">
<img src="https://img.shields.io/github/v/release/nekostul/SoundCloud-Desktop?style=for-the-badge&logo=github&color=FF5500&label=VERSION" alt="Version"/>
</a>

<a href="https://github.com/nekostul/SoundCloud-Desktop/stargazers">
<img src="https://img.shields.io/github/stars/nekostul/SoundCloud-Desktop?style=for-the-badge&logo=github&color=FF5500&label=Stars" alt="Stars"/>
</a>

<a href="https://github.com/nekostul/SoundCloud-Desktop/blob/main/LICENSE">
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

**SoundCloud Desktop** — кастомный форк SoundCloud Desktop с полностью переработанным fullscreen-режимом, cinematic lyrics и улучшенным пользовательским опытом.

Приложение работает через официальный **SoundCloud API**, построено на **Tauri 2 + React 19** и оптимизировано исключительно под Windows.

---

# Особенности

## Полностью бесплатно

- без подписок
- без paywall
- без ограничений
- без рекламы

---

## Доступно в России

Приложение работает напрямую и не требует VPN или дополнительных программ.

---

## Улучшенный fullscreen режим

Полностью переработанный fullscreen UI:

- cinematic lyrics
- адаптивный интерфейс
- плавные анимации
- автоматическое масштабирование под размер окна
- свободный скролл текстов
- автоматический возврат к активной строке
- улучшенный blur overlay

---

## Улучшенные тексты песен

- fullscreen lyrics
- посимвольная синхронизация
- ручной поиск текстов
- автоматическое восстановление текстов между треками
- сохранение состояния fullscreen режима
- fallback поиск при отсутствии текста

---

## Slowed Mode

Встроенное управление скоростью воспроизведения:

- Slowed
- Default Speed
- Speed Up

---

## Нативное приложение

Вместо Electron используется **Tauri 2 (Rust)**:

- маленький размер приложения
- низкое потребление памяти
- быстрый запуск
- плавный интерфейс

---

## Официальный SoundCloud API

Приложение использует официальный API SoundCloud.

---

## SQLite

Вместо PostgreSQL используется SQLite:
- проще установка
- меньше зависимостей
- быстрее запуск
- удобнее для локального desktop приложения

---

# Скачать

## Windows

Скачать последнюю версию:

https://github.com/nekostul/SoundCloud-Desktop/releases/latest

Поддерживаются:
- `.exe`
- `.msi`

Требования:
- Windows 10
- Windows 11

---

# Скриншоты

![fullscreen](https://s10.iimage.su/s/13/gqFLhv5xuaCKGfT0qRznBA8yjwv0C49CfJBFrrDhP.png)

![lyrics](https://s10.iimage.su/s/13/g7b7SgYxckGoQDuwzgNHUwD3lg7FnTrPHIvhSJYzj.png)

![player](https://s10.iimage.su/s/13/gKqyOvcxGOWmusqFXqs4hBdkz65Ga5FEK9q9jqJHl.png)

---

# Сборка из исходников

## Требования

- Node.js 22+
- pnpm
- Rust stable

---

## Запуск

```bash
git clone https://github.com/nekostul/SoundCloud-Desktop.git
cd SoundCloud-Desktop/desktop
pnpm install
pnpm tauri dev
````

---

## Production build

```bash
pnpm tauri build
```

---

# Стек

| Компонент  | Технология   |
| ---------- | ------------ |
| Desktop    | Tauri 2      |
| Frontend   | React 19     |
| Build Tool | Vite 7       |
| Styling    | Tailwind CSS |
| State      | Zustand      |
| Database   | SQLite       |
| Backend    | Rust         |
| UI         | Radix UI     |

---

# Лицензия

MIT License.

SoundCloud является торговой маркой SoundCloud Ltd.

Этот проект не аффилирован с SoundCloud.

---

<p align="center">
<code>soundcloud desktop</code> ·
<code>soundcloud windows</code> ·
<code>soundcloud россия</code> ·
<code>soundcloud без рекламы</code> ·
<code>soundcloud desktop app</code> ·
<code>soundcloud player</code> ·
<code>soundcloud fullscreen lyrics</code> ·
<code>soundcloud cinematic lyrics</code> ·
<code>soundcloud tauri</code>
</p>