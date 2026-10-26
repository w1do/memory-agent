# project-memory

Локальная память проекта для AI-агентов: агент спрашивает через MCP и получает компактный контекст (файлы, символы, связи, сниппеты, хеши, признак актуальности) вместо повторного чтения репозитория.

- **Typesense** — быстрый полнотекстовый, path- и symbol-поиск.
- **Qdrant** — семантический поиск по embeddings (Polza.AI, OpenAI-compatible).
- **SQLite** (`~/.config/project-memory/index/<projectId>/index.db`) — кэш индекса: файлы, chunks, символы, связи. Его можно пересоздать через `memory reindex`. Аннотации агента хранятся в `.memory/annotations.json` внутри проекта и коммитятся. Qdrant/Typesense — производные индексы, которые `memory reindex` обновляет без удаления.
- Имя коллекции = slug имени папки + хеш пути (например `my-app-3fa91c`).
- Всё слушает только `127.0.0.1`, в Docker Compose.

## Быстрый старт

```bash
npm install -g project-memory
cd my-project
memory service up    # один р��з на машину: общие Qdrant + Typesense, ключи в ~/.config/project-memory/global.env
memory init --wait   # дождаться структурного индекса: чанки, символы, связи, лексический поиск
memory sync          # отдельно построить embeddings для семантического поиска
memory search "где авторизация"
```

Требуется Node.js ≥ 22.13 и Docker с Compose v2. Образы: `qdrant/qdrant:v1.19.2`, `typesense/typesense:30.2`.

### Общий сервис

- `memory service up|down|status|logs` управляет одним стеком для всех проектов (порты только на `127.0.0.1`). Настройки и ключи (`TYPESENSE_API_KEY`, `EMBEDDING_*`) лежат в `~/.config/project-memory/global.env` (права 600); каталог можно сменить через `PROJECT_MEMORY_HOME`.
- Кэш индекса `index.db` хранится в `~/.config/project-memory/index/<projectId>/`. В проекте остаются `config.json`, `.ignore`, `annotations.json` (коммитится) и необязательный `.env`.
- `memory mcp` — один процесс для всех проектов: проект берётся из текущего каталога или параметра `project`.

Флаги `init`: `--path <dir>`, `--wait`, `--no-start`, `--no-index`, `--yes`. Теперь `memory init` по умолчанию возвращает `accepted` и `job_id` после сохранения задачи и подтверждения запуска независимого worker. Это ещё не готовый индекс (`ready`): структурный этап готов после состояния `completed`. Скриптам, которым сразу нужен лексический поиск, требуется `--wait`. `init` никогда не вызывает embedding; векторы строятся отдельно через `memory sync`.

`--no-index` отключает первичную индексацию, `--no-start` по-прежнему оставляет только создание конфигурации. Повторный `init` присоединяется к активной инициализации; после прерывания продолжает по manifest. Неизменённые успешно записанные файлы не переиндексируются.

## Конфигурация

`.memory/config.json` — `projectId`, коллекция, `schemaVersion`, лимиты. Секреты и настройки общие для всех проектов и лежат в `~/.config/project-memory/global.env` (права 600), который создаётся при `memory service up`:

```dotenv
TYPESENSE_API_KEY=...        # генерируется автоматически
EMBEDDING_BASE_URL=https://polza.ai/api/v1
EMBEDDING_API_KEY=           # ключ Polza.AI
EMBEDDING_MODEL=openai/text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

Файл `.memory/.env` необязателен: его значения переопределяют глобальные, только если они не пустые.

Без `EMBEDDING_API_KEY` поиск работает в **degraded lexical mode** (Typesense), CLI и MCP явно сообщают `semantic_search_unavailable`.
Исключения по умолчанию (`.env*`, ключи, `node_modules`, …) плюс `.memoryignore` в корне проекта.

`indexConcurrency` в `config.json` (по умолчанию 20) задаёт, сколько файлов индексируется параллельно. `last_index_path` обозначает последнюю полностью завершённую пачку и не продвигается за ошибку файла. После обрыва очередь строится заново по manifest и ошибкам, без отсечения путей по курсору: незавершённые записи пачки повторяются идемпотентно, успешные записи пропускаются. Новые и изменённые файлы перед курсором тоже обрабатываются.

Эмбеддинги считаются только sync-конвейером, отдельным этапом после обхода файлов: чанки из всех файлов собираются в общие батчи. Настройки в `config.json` (необязательные):
- `embedBatchSize` (по умолчанию 96) — число чанков в одном запросе к API эмбеддингов.
- `embedConcurrency` (по умолчанию 2) — сколько запросов к API выполняется одновременно.

Чанки, для которых эмбеддинги не получены (например, API недоступен), остаются в манифесте с `embedded = 0`; следующий `memory sync` доделает их.

## Команды

Все команды запускаются из корня проекта. Опция `--path <dir>` (где поддерживается) указывает другой каталог проекта.

| Команда | Что делает |
| --- | --- |
| `memory service up` | Один раз на машину: поднимает общие Qdrant и Typesense (идемпотентно), создаёт `global.env`. |
| `memory service down\|status\|logs` | Останавливает, показывает состояние или логи общего стека. Данные сохраняются. |
| `memory init [--wait]` | Создаёт конфигурацию и запускает структурную индексацию в фоне: `accepted` + `job_id`. Проверки сервисов выполняет worker; ошибки видны в состоянии задачи. `--wait` ждёт результат без embedding. |
| `memory status [--json]` | Показывает состояние сервисов, число файлов и chunks, `pending_embeddings`, ошибки, дату синхронизации и устаревшие файлы. |
| `memory status --job <id>` | Только сохранённый прогресс задачи, без обхода проекта и сетевых health-check. |
| `memory doctor` | Диагностирует Docker, Qdrant, Typesense, embeddings и манифест и показывает реальный режим поиска. |
| `memory index` | Индексирует новые и изменённые файлы. |
| `memory sync [--background]` | Синхронизирует изменения и строит векторы из pending-чанков. Без флага ждёт результат, `--background` возвращает `accepted` + `job_id`. |
| `memory watch` | Следит за файлами с debounce и обновляет только изменённые. Завершается по `Ctrl+C`. |
| `memory reindex` | Перечитывает все проиндексированные файлы и обновляет Qdrant и Typesense без их удаления. Embeddings создаются только для новых chunks. Аннотации агента (`memory_annotate`) сохраняются и попадают в поиск. |
| `memory reindex <paths...>` | Переиндексирует только указанные файлы (пути относительно корня проекта). Удалённые файлы убираются из индексов. Директории не раскрываются в файлы. |
| `memory search "<query>"` | Ищет по памяти проекта. По умолчанию выводит только уникальные пути найденных файлов и строку актуальной аннотации под путём (помечает `STALE`, если файл изменён после индексации). Опции: `--snippets` (диапазон строк, символ, score и фрагмент кода), `--mode hybrid\|lexical\|semantic`, `--limit <n>`, `--language <lang>`, `--max-chars <n>`, `--json`. |
| `memory docs` | Пишет `.memory/generated/project-memory.md` строго по фактам индекса. |
| `memory mcp --project <abs path>` | Запускает MCP-сервер по stdio. Требует абсолютный путь к проекту. |
| `memory mcp install [--agents claude,junie,codex,opencode]` | Прописывает сервер `project-memory` в конфиги агентов внутри проекта: `.mcp.json` (Claude), `.junie/mcp/mcp.json` (Junie), `.codex/config.toml` (Codex), `opencode.json` (OpenCode). Без `--agents` в терминале показывается список с выбором номеров (Enter — все). Повторный запуск идемпотентен, чужие серверы не трогаются. |

Примеры:

```bash
memory init --path ./my-project --no-start   # только конфигурация и .memory/
memory init --no-index                       # без первичной индексации
memory init --wait                           # дождаться лексического индекса
memory status --job <job_id>                  # быстрый опрос фоновой задачи
memory sync --background                     # embedding в фоновой задаче
memory sync
memory reindex src/auth/AuthService.ts src/auth/TokenService.ts
memory search "где авторизация" --mode hybrid --limit 5   # только пути файлов
memory search "где авторизация" --snippets --max-chars 2000   # с символами, score и фрагментами
memory search "AuthService" --language typescript --json
memory mcp --project /abs/path/to/my-project
```

На проект допускается один писатель индекса: конкурирующие `sync`, `reindex` и обновления получают `busy` с id активной задачи. Задачи сохраняются в `meta` manifest без изменения схемы БД: `queued` → `running` → `completed` / `failed` / `interrupted`. Ошибки файлов или embedding исключают `completed`. Лог задачи очищается от секретов; его путь указан в `log_path`.

Лог-файл `.memory/logs/job-<id>.log` создаётся только на Linux. На других платформах `log_path` = `null`, а `log_unavailable_reason` = `unsupported_platform`.

Ротация логов: хранятся последние 50 завершённых задач (`completed`, `failed`, `interrupted`). Активная задача и текущая не удаляются; при удалении записи удаляется и её лог. Полная политика сроков хранения логов не реализована и вне объёма этого изменения. Heartbeat обновляется раз в секунду; при heartbeat старше 30 с и исчезнувшем владельце (с проверкой повторного использования PID на Linux) задача становится `interrupted`. После этого повторный запуск безопасно продолжает работу. Среда, уничтожающая контейнер или все процессы, может остановить и независимый worker.

## MCP

Быстрая установка во все выбранные агенты проекта: `memory mcp install`.

Глобальная установка (работает в любом проекте без `--project`): `memory mcp install --global`. Конфиги пользователя: `~/.claude.json` (Claude), `~/.junie/mcp/mcp.json` (Junie), `~/.codex/config.toml` (Codex), `~/.config/opencode/opencode.json` (OpenCode). Сервер определяет проект по текущему каталогу (корень git-репозитория); если проект не инициализирован, он сообщает `memory init`.

Вручную — `.memory/mcp.example.json` (пользовательские конфиги автоматически не меняются):

```json
{ "mcpServers": { "project-memory": { "command": "memory", "args": ["mcp", "--project", "/abs/path/to/project"] } } }
```

Инструменты: `memory_search`, `memory_get_context`, `memory_get_file`, `memory_related`, `memory_update`, `memory_sync`, `memory_annotate`, `memory_status`, `memory_project_structure`.
Ресурсы: `memory://project/overview|structure|status`, `memory://file/{path}`.
Перед поиском выполняется быстрая проверка mtime/размера; устаревшие файлы помечаются `is_stale`. После правок агент вызывает `memory_update` (или работает `memory watch`).

`memory_sync(background: true)` запускает тот же sync-конвейер в фоне. `memory_status(job_id: "...")` возвращает только сохранённую задачу: `id`, `operation`, `state`, `stage`, `processed`, `total`, `heartbeat`, `error`, `log_path`. MCP-инструмент первичного init не добавляется.

Обычный `memory_status` сохраняет проверку свежести и health-check; поле `pending_embeddings` отдельно показывает число чанков с `embedded = 0`. Готовность провайдера не означает готовность векторного индекса. В `last_path` поле `indexing` — последняя завершённая пачка структурного этапа, `embedding` — последний завершённый батч эмбеддингов. Пустые значения выводятся как `null`; после успешного завершения этапа его чекпоинт сбрасывается. Продолжение не зависит от порядка путей: структурный этап использует manifest и ошибки, embedding — все чанки с `embedded = 0`. Батчи embedding выполняются параллельно, поэтому его чекпоинт не обязан быть последним путём по сортировке.

### Аннотации агента (`memory_annotate`)

Агент может сохранить короткое описание файла, которое попадает в индекс и помогает поиску понять назначение файла без чтения кода.

- Параметры: `path` (относительно корня проекта), `summary` (от 1 до 200 символов), `role` (`module`, `entry`, `test`, `config`, `doc`, `other`), `content_hash` (sha256 текущего файла, его можно получить командой `sha256sum <path>`).
- Аннотация принимается только для проиндексированного файла, чей `content_hash` совпадает с индексом. Если файл изменился, сначала вызовите `memory_update`.
- Описания, содержащие секреты, отклоняются. Файлы проекта инструмент не меняет.
- Аннотация хранится в таблице `annotations` манифеста и переживает `memory reindex`. Если файл изменился, старая аннотация перестаёт использоваться, пока агент не запишет новую.
- Аннотация учитывается в полнотекстовом поиске Typesense и в payload Qdrant.
- `memory search` выводит аннотацию строкой под путём файла (в обычном и в `--snippets` режиме). Аннотация показывается только если её `content_hash` совпадает с текущим файлом; устаревшие не выводятся.

## Проверка индекса вручную

Имя коллекции лежит в `.memory/config.json` (поле `collection`). Порты и ключ Typesense (`TYPESENSE_API_KEY`) общие и берутся из `~/.config/project-memory/global.env`. Все проверки читают данные и ничего не меняют.

### SQLite (кэш индекса в `~/.config/project-memory/index/<projectId>/index.db`)

Путь к файлу зависит от `projectId` из `.memory/config.json`. Аннотации смотрите в `.memory/annotations.json`.

```bash
DB=~/.config/project-memory/index/$(grep -o '"projectId": *"[^"]*"' .memory/config.json | cut -d'"' -f4)/index.db
sqlite3 "$DB" "SELECT COUNT(*) AS files FROM files;"
sqlite3 "$DB" "SELECT relative_path, size, language, indexed_at FROM files ORDER BY relative_path;"
sqlite3 "$DB" "SELECT COUNT(*) AS chunks FROM chunks;"
sqlite3 "$DB" "SELECT path, message, at FROM index_errors ORDER BY at DESC LIMIT 20;"
sqlite3 "$DB" "SELECT relative_path FROM files WHERE relative_path LIKE 'node_modules/%' OR relative_path LIKE '%.lock' OR relative_path LIKE '%.env%';"
```

Последний запрос должен вернуть пустой результат: мусор и секреты в индекс попадать не должны. Если `sqlite3` не установлен, используйте `apt install sqlite3` или `brew install sqlite`.

### Qdrant (семантический индекс)

```bash
curl -s http://127.0.0.1:<qdrantPort>/collections/<collection>
curl -s -X POST http://127.0.0.1:<qdrantPort>/collections/<collection>/points/count -H 'Content-Type: application/json' -d '{"exact": true}'
```

В ответе `points_count` должен совпадать с числом chunks из SQLite, которые помечены как `embedded = 1`. Если точек нет, а ключ `EMBEDDING_API_KEY` задан, выполните `memory reindex`.

### Typesense (полнотекстовый индекс)

```bash
curl -s http://127.0.0.1:<typesensePort>/health
curl -s http://127.0.0.1:<typesensePort>/collections/<collection> -H "X-TYPESENSE-API-KEY: <TYPESENSE_API_KEY>"
curl -s "http://127.0.0.1:<typesensePort>/collections/<collection>/documents/search?q=AuthService&query_by=symbol,content" -H "X-TYPESENSE-API-KEY: <TYPESENSE_API_KEY>"
```

Первый запрос должен вернуть `{"ok":true}`. Во втором поле `num_documents` показывает число chunks. В третьем видны найденные документы с полями `path` и `line_start`. Значение `<TYPESENSE_API_KEY>` возьмите из `.memory/.env` и не публикуйте его.

### Сводная проверка

```bash
memory status
memory doctor
```

`memory doctor` сверяет состояние Docker, Qdrant, Typesense и embeddings и показывает режим поиска.

## Troubleshooting

- `memory doctor` — реальное состояние Docker, Qdrant, Typesense, embeddings, манифеста.
- Общий стек не отвечает: `memory service status`, затем `memory service logs`. Если порт 6333 или 8108 занят, поменяйте `QDRANT_PORT`/`TYPESENSE_PORT` в `global.env` и повторите `memory service up`.
- Контейнер unhealthy: `memory service logs`.
- Индекс расходится: `memory reindex` (перечитывает файлы и обновляет индексы без удаления).
- Смена модели embeddings или размерности: текущий `memory reindex` не пересчитывает векторы уже проиндексированных chunks. Полного пересчёта пока нет.

## Rollback

Общий сервис: `memory service down` (данные сохраняются). Ключи в `~/.config/project-memory/global.env` не удаляются.

Исходники проекта `memory` никогда не изменяет и не удаляет.

## Разработка

```bash
npm run build && npm test && npm run test:integration   # интеграционные тесты требуют Docker
npm pack
```
