# project-memory

Локальная память проекта для AI-агентов: агент спрашивает через MCP и получает компактный контекст (файлы, символы, связи, сниппеты, хеши, признак актуальности) вместо повторного чтения репозитория.

- **Typesense** — быстрый полнотекстовый, path- и symbol-поиск.
- **Qdrant** — семантический поиск по embeddings (Polza.AI, OpenAI-compatible).
- **SQLite** (`.memory/index.db`) — канонический манифест. Qdrant/Typesense — производные, пересоздаются `memory reindex`.
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

`init`, `start`, `stop`, `status`, `doctor`, `index`, `sync`, `watch`, `reindex`, `docs`, `search "<query>"`, `mcp --project <abs path>`.
`memory docs` пишет `.memory/generated/project-memory.md` строго по фактам индекса.

## MCP

`.memory/mcp.example.json` (пользовательские конфиги автоматически не меняются):

```json
{ "mcpServers": { "project-memory": { "command": "memory", "args": ["mcp", "--project", "/abs/path/to/project"] } } }
```

Инструменты: `memory_search`, `memory_get_context`, `memory_get_file`, `memory_related`, `memory_update`, `memory_sync`, `memory_status`, `memory_project_structure`.
Ресурсы: `memory://project/overview|structure|status`, `memory://file/{path}`.
Перед поиском выполняется быстрая проверка mtime/размера; устаревшие файлы помечаются `is_stale`. После правок агент вызывает `memory_update` (или работает `memory watch`).

## Troubleshooting

- `memory doctor` — реальное состояние Docker, Qdrant, Typesense, embeddings, манифеста.
- Контейнер unhealthy: `docker compose -f .memory/docker-compose.yml logs`.
- Порт занят: поменяйте `qdrantPort`/`typesensePort` в `config.json`, затем `memory init`.
- Индекс расходится: `memory reindex`.
- Смена модели embeddings/размерности: `memory reindex`.

## Rollback

```bash
memory stop
rm -rf .memory        # данные на Linux могут принадлежать контейнеру: sudo rm -rf
# убрать строку .memory/ из .gitignore при необходимости
```

Исходники проекта `memory` никогда не изменяет и не удаляет.

## Разработка

```bash
npm run build && npm test && npm run test:integration   # интеграционные тесты требуют Docker
npm pack
```
