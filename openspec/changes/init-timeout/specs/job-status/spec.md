# job-status

Состояние фоновой задачи и быстрый опрос.

## Состояния

- `queued` → `running` → `completed` / `failed` / `interrupted`.
- `completed` SHALL NOT устанавливаться, если есть ошибки соответствующей операции.

## Требования

### Требование: быстрый опрос

`memory status --job <id>` и `memory_status(job_id)` SHALL возвращать только сохранённый прогресс. Они SHALL NOT сканировать проект и SHALL NOT делать сетевых health-check.

Сценарий: опрос во время работы
- Given задача `running`, heartbeat обновляется
- When выполняется `memory status --job <id>`
- Then ответ содержит этап, обработано / всего, heartbeat и ошибку (если есть)
- And обход проекта не выполняется

### Требование: обнаружение падения

Падение worker SHALL обнаруживаться по `heartbeat` и проверке владельца процесса. Задача SHALL переходить в `interrupted`.

Сценарий: падение worker
- Given задача `running`, heartbeat устарел, процесс-владелец не существует
- When выполняется опрос или новый `memory init`
- Then состояние становится `interrupted`
- And повторный запуск возобновляет работу (см. `resume`)

### Требование: ошибка исключает completed

Сценарий: частичная ошибка
- Given задача завершила обход, но есть ошибки отдельных файлов
- When состояние вычисляется
- Then состояние SHALL быть `failed`, а не `completed`

### Требование: лог задачи по платформам

Лог-файл `.memory/logs/job-<id>.log` SHALL создаваться только на Linux. На других платформах `log_path` SHALL быть `null`, а `log_unavailable_reason` SHALL быть `unsupported_platform`.

Сценарий: задача на Linux
- Given задача запущена на Linux
- When выполняется опрос `memory status --job <id>` или `memory_status(job_id)`
- Then `log_path` указывает на `job-<id>.log`
- And `log_unavailable_reason` не задан

Сценарий: задача вне Linux
- Given задача запущена не на Linux
- When выполняется опрос `memory status --job <id>` или `memory_status(job_id)`
- Then `log_path` = `null`
- And `log_unavailable_reason` = `unsupported_platform`

### Требование: ротация логов задач

Хранятся последние 50 завершённых задач (`completed`, `failed`, `interrupted`). Активная задача и текущая задача SHALL NOT удаляться. При удалении записи её лог удаляется вместе с ней.

Полная политика сроков хранения логов SHALL NOT считаться реализованной: она вне объёма этого изменения.

### Требование: sync --background без ключа эмбеддингов

Если ключ эмбеддингов не задан, `memory sync --background` (и `memory_sync(background: true)`) завершает задачу как `failed` из-за `semanticError`.

Сценарий: фоновый sync без ключа
- Given ключ эмбеддингов не задан
- When выполняется `memory sync --background`
- Then задача возвращает `accepted` и `job_id`
- And итоговое состояние задачи `failed`, причина — `semanticError`

### Требование: обычный status не меняется

Обычный `memory status` SHALL сохранить проверку свежести через сканирование ([src/project/status.ts:29](src/project/status.ts:29), [src/search/freshness.ts:15](src/search/freshness.ts:15)).

## Не проверено

- Работа в среде, уничтожающей контейнер или всю группу процессов, не проверена.
- Полная политика сроков хранения логов задач: не реализована, вне объёма.

## Выбранные параметры реализации

UUID задачи и её поля сохраняются в существующей таблице meta до сканирования. Лог: `.memory/logs/job-<uuid>.log` (только на Linux, см. требование «лог задачи по платформам»), сообщения проходят redaction. Хранятся последние 50 завершённых задач. Heartbeat: 1 с; порог устаревания: 30 с. Живой владелец сохраняет блокировку; на Linux дополнительно проверяется время старта PID, чтобы исключить повторное использование PID.
