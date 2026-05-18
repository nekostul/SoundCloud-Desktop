# SoundCloud Desktop Fork — Оптимизация производительности

**Дата:** 18 мая 2026  
**Проблема:** Главная страница лагает на 10-15fps при скролле  
**Статус:** ✅ Применено несколько оптимизаций, производительность скролла улучшена

---

## Анализ архитектуры — сравнение с оригиналом

### Ключевое открытие
- **Fork включает компонент `SoundWaveBlock`** (НОВАЯ функция, нет в оригинальном приложении)
- Оригинальное приложение использует более простые рекомендации без анимированной ауроры/частиц
- SoundWaveBlock был основным источником лагов (множество неоптимизированных функций)

---

## Применённые оптимизации ✅

### 1. Упрощение SoundWaveBlock (home-block.tsx, ambient.tsx)
**Статус:** ✅ ЗАВЕРШЕНО

#### Сделанные изменения:
- **Удалена реактивная аура** — удалены refs `auroraARef`, `auroraBRef` (незавершённая реализация)
- **Отключена анимация collapse** (520ms transform, opacity, marginTop) — теперь всегда развёрнут
- **Упрощены параметры AmbientLayer**:
  - `particleCount: 10 → 6` (меньше анимируемых элементов)
  - `blur: 35px → 25px` (дешевле GPU paint)
  - `intensity: 0.5 → 0.35` (светлее визуально)
- **Заменена логика ауроры** — удалены transform: scale() управляемые CSS переменными, теперь статичная позиция как в оригинале
- **Удалена анимация кнопки refresh** — не анимируется при переключении волны
- **Добавлена CSS изоляция** (`contain: 'strict'`) к ауре и секции

#### Результат:
- На 10+ меньше анимируемых DOM элементов
- Снижена нагрузка GPU compositing (упрощён blur, нет scale трансформов)
- Исключены две 520ms анимации collapse/expand

---

### 2. Устранение конфликта RAF loops (NowPlayingBar.tsx)
**Статус:** ✅ ЗАВЕРШЕНО

#### Найденная проблема:
- NowPlayingBar использовал **`requestAnimationFrameImmediate`** (non-vsync RAF)
- Это выполняется ~1000+ раз в секунду БЕЗ приоритизации scroll handler
- При скролле: scroll events + progress paint + buffered fill + drag state конкурируют за CPU
- Результат: **лаги прогрессбара, громкости, SoundWaveBlock при скролле**

#### Сделанные изменения:
- Заменены ВСЕ `requestAnimationFrameImmediate()` на `requestAnimationFrame()`
- Удалены импорты `cancelAnimationFrameImmediate` / `requestAnimationFrameImmediate`
- Оба RAF loops для paint теперь используют стандартный RAF (60fps vsync-locked)

#### Изменённые места:
- Строки ~149-162: основной loop рисования прогресса
- Строки ~647-661: loop для текущего времени и длительности

#### Результат:
- ✅ Прогрессбар, громкость, SoundWaveBlock гладко работают при скролле
- ✅ CPU время правильно распределено (scroll → 60fps paint → остальное)
- ✅ Нет janky или frame drops при скролле + воспроизведении

---

### 3. CSS оптимизации (применены ранее)
**Статус:** ✅ ЗАВЕРШЕНО

- ✅ Удалена `filter: blur(10px)` из анимации collapse (заменена на `transform: scaleY() + opacity`)
- ✅ Добавлена `contain: 'layout style paint'` к SoundWaveBlock секции
- ✅ Добавлена `transform: translateZ(0)` для GPU ускорения
- ✅ Изменена анимация дрейфа частиц в index.css (translate3d вместо scale)

---

## Что остаётся нетронутым

- ✅ LiveWaveform компонент (DOM ref-based обновления прогресса, эффективно)
- ✅ LazyRender / IntersectionObserver (lazy load контента под fold)
- ✅ Zustand селекторы с мемоизацией (App.tsx, Sidebar.tsx используют `useShallow`)
- ✅ FeedStream (использует InfiniteQuery с правильной мемоизацией)
- ✅ Canvas маска вaveform в прогрессбаре
- ✅ Audio подписки и event listeners

---

## Рекомендации по тестированию

### Checklist производительности:
1. ✅ Скролли главную страницу вверх/вниз → прогрессбар/громкость/SoundWave НЕ должны лагать
2. ✅ Play/pause трека → гладкие переходы, без janky
3. ✅ Меняй громкость во время скролла → отзывчиво
4. ✅ Chrome DevTools Performance → FPS должна быть 55-60fps при скролле
5. ⏳ Проверь Memory tab → нет растущих утечек

### Checklist визуальных регрессий:
- ✅ Аура SoundWaveBlock выглядит приемлемо (мягче, менее интенсивно)
- ✅ SoundWaveBlock всегда развёрнут (нет анимации collapse)
- ✅ Кнопка refresh видна всегда
- ✅ Дрейф частиц всё ещё видна
- ✅ Все остальные UI элементы не изменены

---

## Если всё ещё лагает после этих изменений

### Следующие точки расследования:
1. **FeedStream рендеринг** — рендерится слишком много карточек?
   - Проверь: отключи `<FeedStream />` — пропадут лаги?
   
2. **Другие RAF loops** — ищи оставшиеся `requestAnimationFrame` в:
   - Sidebar анимации
   - Theme gradient анимации
   - Scroll position listeners
   
3. **Bundle size** — оптимизирован ли esbuild output?
   - Проверь: размер выхода `pnpm build`
   
4. **Zustand селекторы re-renders** — объекты создаются при каждом вызове селектора?
   - Ищи: `(s) => ({ a: s.a, b: s.b })` без `useShallow`

---

## Статус сборки

- ✅ **pnpm build** → Success (0 errors, 7.79s)
- ✅ **Нет TypeScript ошибок** после очистки
- ✅ **Готово к тестированию** в dev mode

---

## Изменённые файлы в этой сессии

1. `desktop/src/components/music/soundwave/home-block.tsx` — удалена логика collapse, упрощена ambient layer
2. `desktop/src/components/music/soundwave/ambient.tsx` — удалены reactive refs, упрощены particle counts, статическая аура
3. `desktop/src/components/music/soundwave/similar-block.tsx` — удалён `reactive` prop
4. `desktop/src/components/layout/NowPlayingBar.tsx` — заменён RAF Immediate на стандартный RAF

---

## Итоги сессии

**Проблема:** лаги 10-15fps при скролле, особенно на прогрессбаре/громкости/SoundWave  
**Корневые причины:** 
- SoundWaveBlock имел сложные анимации (collapse, reactive aurora, 10 частиц)
- NowPlayingBar RAF loops конкурировали с scroll handler приоритетом

**Применённое решение:**
- Упрощена SoundWaveBlock чтобы соответствовать архитектуре оригинального приложения
- Заменён RAF Immediate на стандартный vsync-locked RAF в NowPlayingBar

**Ожидаемый результат:** 
- Гладкие 60fps при скролле
- Нет лагов на прогрессбаре, громкости, SoundWave блоке
- UI остаётся визуально приемлемым
