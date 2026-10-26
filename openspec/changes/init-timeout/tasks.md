# Задачи: исправление таймаута `memory init`

Отметки `[x]` ставятся только после реализации и проверки по коду. D1, B1, C1, C2 и O1 отмечены по приёмке. V1 не отмечен: его проверки (полный `npm test`, стендовый замер) не подтверждены, см. раздел «Протокол проверки». A1 не выполнен и вне текущего объёма. Полная политика сроков хранения логов не реализована и вне объёма.

Порядок: D1 → B1 → C1 → C2 → O1 → V1. A1 — отдельное изменение после V1.

## D1. Безопасное возобновление

- [x] Падение внутри пачки, ошибки отдельных файлов и изменения перед курсором `last_index_path` не теряются.
- [x] Успешно записанные файлы повторно не индексируются.
- [x] Очередь после возобновления строится по manifest и ошибкам, без отсечения `path <= last_index_path`.

Проверка: `npm test -- test/unit/sync-checkpoint.test.ts`

Ссылки: [src/indexing/sync.ts:81](src/indexing/sync.ts:81), [src/indexing/sync.ts:92](src/indexing/sync.ts:92).

## B1. Разделить фазы

- [x] `init` делает ноль вызовов embedding.
- [x] `sync` обрабатывает pending-чанки (`embedded = 0`).
- [x] Повторный `sync` не дублирует векторы.
- [x] `FileIndexer` не создаёт векторы.

Проверка: `npm test -- test/unit/sync-checkpoint.test.ts test/unit/embed-pending.test.ts test/unit/pending-embeddings.test.ts`

Ссылки: [src/cli/commands/init.ts:29](src/cli/commands/init.ts:29) (Sol: `init.ts:35`), [src/indexing/sync.ts:94](src/indexing/sync.ts:94), [src/indexing/embed-pending.ts:16](src/indexing/embed-pending.ts:16).

## C1. Фоновый запуск и контракт CLI/MCP

- [x] Родитель возвращает `accepted` до завершения worker; `accepted` возвращается после сохранения задачи и подтверждения запуска.
- [x] Worker переживает завершение родителя.
- [x] Ошибка запуска видна вызывающему.
- [x] `memory init --wait` ждёт результат структурного этапа.
- [x] `--no-index` и `--no-start` работают как прежде.
- [x] `memory sync --background` и `memory_sync(background: true)` работают; синхронный `sync` совместим.
- [x] MCP-инструмент первичного init не добавлен.

Проверка: `npm test -- test/unit/shared-init.test.ts`

Ссылки: [src/cli/index.ts:33](src/cli/index.ts:33), [src/cli/index.ts:27](src/cli/index.ts:27), [src/cli/commands/init.ts:27](src/cli/commands/init.ts:27), [src/mcp/tools.ts:115](src/mcp/tools.ts:115).

## C2. Состояние задачи и конкуренция

- [x] Задача сохраняется в manifest до сканирования: `id`, операция, состояние, этап, обработано / всего, `heartbeat`, ошибка, путь к очищенному логу.
- [x] Состояния `queued` → `running` → `completed` / `failed` / `interrupted`.
- [x] `completed` без ошибок соответствующей операции.
- [x] Один писатель: конкурирующая операция получает `busy` с id активной задачи.
- [x] Повторный `init` присоединяется к активной инициализации.
- [x] Падение worker даёт `interrupted`; повторный запуск возобновляет работу.
- [x] `memory status --job <id>` и `memory_status(job_id)` не сканируют проект и не делают сетевых health-check.

Проверка: `npm test -- test/unit/shared-init.test.ts`

Ссылки: [src/project/status.ts:29](src/project/status.ts:29), [src/search/freshness.ts:15](src/search/freshness.ts:15), [src/storage/manifest.ts](src/storage/manifest.ts) (строка не указана в сводках).

## A1. Учёт `.gitignore` (отдельное изменение, вне текущего объёма)

- [ ] Вложенные `.gitignore`, отрицания и привязка шаблонов соответствуют Git.
- [ ] Встроенные запреты и `.memoryignore` нельзя отменить отрицанием.
- [ ] Учёт `.gitignore` можно отключить.
- [ ] Исключённые каталоги не обходятся.
- [ ] Лимит 512 KiB сохранён.

Проверка: `npm test -- test/unit/default-excludes.test.ts`

Ссылки: [src/project/scan.ts:16](src/project/scan.ts:16), [src/project/config.ts:18](src/project/config.ts:18), [src/security/policy.ts:8](src/security/policy.ts:8).

Риск: меняет состав индекса (см. `design.md`, раздел 6).

## O1. Закрепить OpenSpec и README

- [x] Описаны `accepted` / `ready`, отдельный `sync`, повторение пачки, новые параметры и смена поведения `init`.
- [x] README: исправлено описание `last_index_path` ([README.md:40](README.md:40)).

Проверка: `rg -n 'accepted|background|--wait|last_index_path|пачк' README.md openspec`

## V1. Итоговая проверка контракта

- [ ] Все unit-тесты проходят.
- [ ] На контролируемом большом проекте при готовом общем сервисе `accepted` получен менее чем за 10 с.
- [ ] Время полного индексирования измерено отдельно.

Проверка:

- `npm test`
- стендовый замер: `/usr/bin/time -p memory init --path "$FIXTURE_ROOT"` (с `--wait` отдельно для полного времени)

Не проверено: фактическое время до внедрения; целевая среда при уничтожении группы процессов.

## Протокол проверки

- TypeScript исходников и изменённых тестов: exit 0 (`tsc --noEmit`; расширенный конфиг только в /tmp).
- D1, B1, C1 и C2: команды из разделов выше вызваны через обязательный flock; exit 73 до запуска npm. Отметки D1, B1, C1, C2 поставлены по приёмке; повторный прогон unit-проверок в этом документе не зафиксирован.
- O1: `rg -n 'accepted|background|--wait|last_index_path|пачк' README.md openspec`, exit 0.
- V1: полный npm test и стендовые замеры не подтверждены; причина — недоступный guards.lock. На реальном проекте init/sync/reindex не запускались. Пункты V1 не отмечены.
