# eFigmaBridge

Десктопный мост между LLM (MCP) и Figma. Electron-приложение поднимает WebSocket-мост,
к нему подключаются Figma-плагин и MCP-адаптер(ы) выбранных LLM — без терминала для
пользователя: кнопка запуска, готовый JSON конфига MCP и путь к манифесту плагина.

## Запуск

- Разработка: `npm run dev` (нужен Node; в этом репозитории есть portable `tools/node/node.exe`).
- Сборка приложения: `npm run build` → `scripts/dist.mjs` собирает дистрибутив в `release*/`.
- Smoke-тест без Figma: `./tools/node/node.exe scripts/smoke-test.mjs` (мост + имитатор плагина + адаптер).

После первого запуска приложение синкает адаптер и плагин в стабильный путь
(`%LOCALAPPDATA%\eFigmaBridge\runtime\` на Windows, `~/Library/Application Support/eFigmaBridge/runtime` на macOS)
— именно эти пути приложение показывает в окне (JSON конфига MCP и `manifest.json` для импорта плагина в Figma).

## Сборка под Windows и macOS

Разработка ведётся на Windows; macOS-версия нужна дизайнеру для тестирования.

- **Windows**: `npm run dist` локально — portable exe (x64) в `release/`.
- **macOS**: пакет можно собрать **только на macOS** (подпись Apple не кроссплатформенна).
  Поэтому сборка идёт в CI: `.github/workflows/build.yml` на каждый пуш в `main`
  собирает обе платформы (Windows x64 + macOS arm64 zip/dmg) и складывает в Artifacts.
  Локально на Mac: `npm ci && (cd packages/figma-plugin && node build.mjs) && npm run build && node scripts/dist.mjs`
  (цель определяется по ОС; можно явно `DIST_TARGET=mac`).
- Golden Gate 27.x — только Apple Silicon, поэтому macOS-сборка собирается в `arm64`.

### Инструкция для дизайнера (macOS)

1. Установить Node.js: `brew install node` (нужен MCP-адаптеру; конфиг LLM ссылается на `node` из PATH).
2. Скачать `eFigmaBridge-macos-arm64` из Artifacts (zip или dmg), распаковать,
   перетащить `eFigmaBridge.app` в «Программы».
3. **Снять карантин** (приложение без подписи Apple, иначе macOS пишет «файл повреждён»):
   открыть Терминал и выполнить
   ```
   xattr -cr /Applications/eFigmaBridge.app
   ```
   (подсказка: набрать `xattr -cr ` с пробелом и перетащить иконку приложения в окно Терминала —
   путь подставится сам). Если приложение в «Загрузках»: `xattr -cr ~/Downloads/eFigmaBridge.app`.
4. Запустить обычным двойным кликом.
   (Для свободного распространения без этого шага нужен Apple Developer ID, $99/год + нотаризация.)
5. Нажать кнопку запуска, скопировать JSON в конфиг своей LLM и импортировать
   `manifest.json` из показанного пути в Figma Desktop (Plugins → Development → Import plugin from manifest…).

## Структура

- `electron/` — главный процесс и WS-мост (`bridge.cjs`, порты 9323–9325).
- `adapter/` — stdio MCP-сервер `mcp-stdio.mjs` + декларации `tools.json` (источник истины по tools).
- `packages/figma-plugin/` — исходники плагина (TypeScript → esbuild в `dist/`).
- `packages/shared/` — общие типы протокола.
- `renderer/` — окно на Vue 3 + Tailwind.
- `docs/` — примеры батчей для `run_batch`.
- `scripts/` — сборка exe, smoke-тест, миграции tools.json.

## Инструменты (68)

Все tools объявлены в `adapter/tools.json` и выполняются плагином. Группы: переменные и
коллекции, стили, узлы/дерево, экспорт (PNG/SVG/CSS), аннотации, `run_batch`,
Auto Layout и компоненты (ниже).

### Auto Layout и оформление

| Tool | Назначение |
| --- | --- |
| `set_frame_layout` | Направление, отступы, padding, sizing/выравнивание осей, wrap на FRAME/COMPONENT/INSTANCE. Включает auto layout, если его не было. |
| `set_node_fills` / `set_node_strokes` | Замена заливок/обводок списком красок (SOLID hex или привязка COLOR-переменной, градиенты с hex-стопами и углом), `clear: true` — очистка. Для обводок также `strokeWeight`/`strokeAlign`. |
| `set_node_corner_radius` | Радиус одним числом или по углам `{ topLeft, topRight, bottomRight, bottomLeft }`. |
| `set_node_size` | Размеры и/или sizing по осям (FIXED/HUG/FILL). Правила Figma проверяются до применения: HUG — только auto-layout фрейм или текст, FILL — только внутри auto-layout родителя. |
| `set_node_layout_child` | Поведение ребёнка auto layout: `layoutGrow`, `layoutAlign`, `layoutPositioning`; `constraints` вне auto layout. |
| `create_rectangle` / `create_ellipse` | Фигура с размерами, красками, обводкой и радиусом (прямоугольник) за один вызов. |
| `apply_style` | Применить локальный стиль к узлу: `fill`/`stroke`/`text`/`effect` (тип стиля проверяется). |
| `bind_node_variable` | Привязать переменную к полю узла (`variableId: null` — отвязать). `fills`/`strokes` привязываются к **первому** paint (SOLID, COLOR-переменная); числовые поля — `width`, `height`, `itemSpacing`, `padding*`, `*Radius`, `fontSize` (FLOAT-переменная). |
| `create_frame` (расширен) | Опциональные `layout`, `fills`, `strokes`, `strokeWeight`, `cornerRadius` — каркас собирается за один вызов. |

### Компоненты

| Tool | Назначение |
| --- | --- |
| `create_component_from_node` | Узел → компонент: auto layout, привязки переменных и стили сохраняются. Опц. `name`. Ошибка для страницы, инстанса и узла внутри инстанса. |
| `create_component` | Пустой компонент в родителе, опц. размер и позиция. |
| `create_component_set` | `figma.combineAsVariants`: набор вариантов из готовых компонентов; каждый id проверяется на COMPONENT до объединения. |
| `set_component_properties` | Свойства компонента/набора: `description` (пустая строка очищает). |

Общие гарантии: всё валидируется **до** применения — при ошибке файл не меняется;
ошибки `NOT_FOUND` (узел/переменная/стиль) и `INVALID_ARGUMENT` (значение/правило);
все tools совместимы с `run_batch`.

## Приёмка: карточка отзыва

`docs/review-card.batch.json` собирает карточку на Auto Layout одним `run_batch`:
коллекция переменных `UI/Review Card`, карточка (VERTICAL, padding 20, gap 16, radius 16),
шапка с аватаром и именем/датой, рейтинг из 5 звёзд и текст — цвета привязаны к переменным.

1. В шаге 8 подставьте id своей страницы вместо `0:1`.
2. Вызовите `run_batch` с `{ "file": "<абсолютный путь>/docs/review-card.batch.json" }`.
3. Для визуальной проверки: `export_node_png` по id карточки из лога батча.
