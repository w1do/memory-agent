# project-memory

Локальная память проекта для AI-агентов: агент спрашивает через MCP и получает компактный контекст (файлы, символы, связи, сниппеты, хеши, признак актуальности) вместо повторного чтения репозитория.

- **Typesense** — быстрый полнотекстовый, path- и symbol-поиск.
- **Qdrant** — семантический поиск по embeddings (Polza.AI, OpenAI-compatible).
- **SQLite** (`.memory/index.db`) — канонический манифест: файлы, chunks, символы, связи и аннотации агента. Qdrant/Typesense — производные индексы, которые `memory reindex` обновляет без удаления.
- Имя коллекции = slug имени папки + хеш пути (например `my-app-3fa91c`).
- Всё слушает только `127.0.0.1`, в Docker Compose.

## Быстрый старт

```bash
npm install -g project-memory
cd my-project
memory init          # .memory/, docker compose, индексация, тестовый поиск, MCP-пример
memory search "где авторизация"
```

Требуется Node.js ≥ 22.13 и Docker с Compose v2. Образы: `qdrant/qdrant:v1.19.2`, `typesense/typesense:30.2`.

Флаги `init`: `--path <dir>`, `--no-start`, `--no-index`, `--yes`. Повторный `init` идемпотентен: данные и `.env` не трогаются, неизменённые файлы не переиндексируются.

## Конфигурация

`.memory/config.json` — порты, коллекция, лимиты. `.memory/.env` — секреты (в Git не попадает):

```dotenv
TYPESENSE_API_KEY=...        # генерируется автоматически
EMBEDDING_BASE_URL=https://polza.ai/api/v1
EMBEDDING_API_KEY=           # ключ Polza.AI
EMBEDDING_MODEL=openai/text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

Без `EMBEDDING_API_KEY` поиск работает в **degraded lexical mode** (Typesense), CLI и MCP явно сообщают `semantic_search_unavailable`.
Исключения по умолчанию (`.env*`, ключи, `node_modules`, …) плюс `.memoryignore` в корне проекта.

## Команды

Все команды запускаются из корня проекта. Опция `--path <dir>` (где поддерживается) указывает другой каталог проекта.

| Команда | Что делает |
| --- | --- |
| `memory init` | Создаёт `.memory/` и `.memoryignore`, поднимает Qdrant и Typesense, создаёт коллекции, индексирует проект, делает тестовый поиск и пишет `.memory/mcp.example.json`. |
| `memory start` | Запускает Qdrant и Typesense через Docker Compose (данные сохраняются). |
| `memory stop` | Останавливает контейнеры. Данные в `.memory/data/` не удаляются. |
| `memory status [--json]` | Показывает состояние сервисов, число файлов и chunks, ошибки, дату последней синхронизации и число устаревших файлов. |
| `memory doctor` | Диагностирует Docker, Qdrant, Typesense, embeddings и манифест и показывает реальный режим поиска. |
| `memory index` | Индексирует новые и изменённые файлы. |
| `memory sync` | Синхронизирует изменения: новые, изменённые, переименованные и удалённые файлы. Неизменённые не перечитываются. |
| `memory watch` | Следит за файлами с debounce и обновляет только изменённые. Завершается по `Ctrl+C`. |
| `memory reindex` | Перечитывает все проиндексированные файлы и обновляет Qdrant и Typesense без их удаления. Embeddings создаются только для новых chunks. Аннотации агента (`memory_annotate`) сохраняются и попадают в поиск. |
| `memory reindex <paths...>` | Переиндексирует только указанные файлы (пути относительно корня проекта). Удалённые файлы убираются из индексов. Директории не раскрываются в файлы. |
| `memory search "<query>"` | Ищет по памяти проекта. По умолчанию выводит только уникальные пути найденных файлов и строку актуальной аннотации под путём (помечает `STALE`, если файл изменён после индексации). Опции: `--snippets` (диапазон строк, символ, score и фрагмент кода), `--mode hybrid\|lexical\|semantic`, `--limit <n>`, `--language <lang>`, `--max-chars <n>`, `--json`. |
| `memory docs` | Пишет `.memory/generated/project-memory.md` строго по фактам индекса. |
| `memory mcp --project <abs path>` | Запускает MCP-сервер по stdio. Требует абсолютный путь к проекту. |

Примеры:

```bash
memory init --path ./my-project --no-start   # только конфигурация и .memory/
memory init --no-index                       # без первичной индексации
memory sync
memory reindex src/auth/AuthService.ts src/auth/TokenService.ts
memory search "где авторизация" --mode hybrid --limit 5   # только пути файлов
memory search "где авторизация" --snippets --max-chars 2000   # с символами, score и фрагментами
memory search "AuthService" --language typescript --json
memory mcp --project /abs/path/to/my-project
```

Флаги `init`: `--path <dir>`, `--no-start`, `--no-index`, `--yes` (поведение по умолчанию, режим без вопросов). Повторный `init` идемпотентен: данные и `.env` не трогаются, неизменённые файлы не переиндексируются.

## MCP

`.memory/mcp.example.json` (пользовательские конфиги автоматически не меняются):

```json
{ "mcpServers": { "project-memory": { "command": "memory", "args": ["mcp", "--project", "/abs/path/to/project"] } } }
```

Инструменты: `memory_search`, `memory_get_context`, `memory_get_file`, `memory_related`, `memory_update`, `memory_sync`, `memory_annotate`, `memory_status`, `memory_project_structure`.
Ресурсы: `memory://project/overview|structure|status`, `memory://file/{path}`.
Перед поиском выполняется быстрая проверка mtime/размера; устаревшие файлы помечаются `is_stale`. После правок агент вызывает `memory_update` (или работает `memory watch`).

### Аннотации агента (`memory_annotate`)

Агент может сохранить короткое описание файла, которое попадает в индекс и помогает поиску понять назначение файла без чтения кода.

- Параметры: `path` (относительно корня проекта), `summary` (от 1 до 200 символов), `role` (`module`, `entry`, `test`, `config`, `doc`, `other`), `content_hash` (sha256 текущего файла, его можно получить командой `sha256sum <path>`).
- Аннотация принимается только для проиндексированного файла, чей `content_hash` совпадает с индексом. Если файл изменился, сначала вызовите `memory_update`.
- Описания, содержащие секреты, отклоняются. Файлы проекта инструмент не меняет.
- Аннотация хранится в таблице `annotations` манифеста и переживает `memory reindex`. Если файл изменился, старая аннотация перестаёт использоваться, пока агент не запишет новую.
- Аннотация учитывается в полнотекстовом поиске Typesense и в payload Qdrant.
- `memory search` выводит аннотацию строкой под путём файла (в обычном и в `--snippets` режиме). Аннотация показывается только если её `content_hash` совпадает с текущим файлом; устаревшие не выводятся.

## Проверка индекса вручную

Порты и имя коллекции лежат в `.memory/config.json` (поля `qdrantPort`, `typesensePort`, `collection`). Ключ Typesense — в `.memory/.env` (`TYPESENSE_API_KEY`). Все проверки читают данные и ничего не меняют.

### SQLite (`.memory/index.db`) — канонический манифест

```bash
sqlite3 .memory/index.db "SELECT COUNT(*) AS files FROM files;"
sqlite3 .memory/index.db "SELECT relative_path, size, language, indexed_at FROM files ORDER BY relative_path;"
sqlite3 .memory/index.db "SELECT COUNT(*) AS chunks FROM chunks;"
sqlite3 .memory/index.db "SELECT path, message, at FROM index_errors ORDER BY at DESC LIMIT 20;"
sqlite3 .memory/index.db "SELECT relative_path, role, summary, author, updated_at FROM annotations ORDER BY relative_path;"
sqlite3 .memory/index.db "SELECT relative_path FROM files WHERE relative_path LIKE 'node_modules/%' OR relative_path LIKE '%.lock' OR relative_path LIKE '%.env%';"
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
- Контейнер unhealthy: `docker compose -f .memory/docker-compose.yml logs`.
- Порт занят: поменяйте `qdrantPort`/`typesensePort` в `config.json`, затем `memory init`.
- Индекс расходится: `memory reindex` (перечитывает файлы и обновляет индексы без удаления).
- Смена модели embeddings или размерности: текущий `memory reindex` не пересчитывает векторы уже проиндексированных chunks. Полного пересчёта пока нет.

## Rollback

```bash
memory stop
cp .memory/.env ~/project-memory.env.bak      # сохранить ключи (EMBEDDING_API_KEY, TYPESENSE_API_KEY)
rm -rf .memory        # данные на Linux могут принадлежать контейнеру: sudo rm -rf
# вернуть ключи до повторного init:
mkdir -p .memory && cp ~/project-memory.env.bak .memory/.env
```

Исходники проекта `memory` никогда не изменяет и не удаляет. Файл `.memory/.env` при `memory init` и повторной установке не перезаписывается: существующие значения сохраняются, отсутствующие ключи только дописываются.

## Разработка

```bash
npm run build && npm test && npm run test:integration   # интеграционные тесты требуют Docker
npm pack
```
