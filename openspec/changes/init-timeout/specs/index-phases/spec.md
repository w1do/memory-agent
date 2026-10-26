# index-phases

Разделение структурной индексации (`init`) и embedding (`sync`).

## Требования

### Требование: init не вызывает embedding

`memory init` SHALL NOT вызывать embedding API и SHALL NOT создавать векторы.

Сценарий: init на проекте с файлами
- Given проект с поддерживаемыми файлами
- When выполняется `memory init`
- Then число вызовов embedding равно нулю
- And чанки записаны с `embedded = 0`

### Требование: лексический поиск после структурного этапа

После завершения структурного этапа лексический поиск SHALL быть доступен.

### Требование: векторы строит только sync

Только sync-конвейер SHALL строить векторы из чанков с `embedded = 0`. `FileIndexer` SHALL NOT строить векторы.

Сценарий: повторный sync
- Given чанки с `embedded = 0` после init
- When выполняется `memory sync`
- Then pending-чанки обрабатываются
- And повторный `memory sync` не создаёт дублей векторов

Сценарий: сбой embedding
- Given сбой embedding API во время sync
- When sync завершается
- Then неуспешные чанки остаются с `embedded = 0`
- And следующий `memory sync` подбирает их

### Требование: готовность провайдера не равна готовности индекса

Готовность embedding-провайдера SHALL NOT означать, что векторный индекс готов. Статус SHALL показывать отдельно число чанков с `embedded = 0`.

## Не проверено

- Обычный CLI/MCP status возвращает `pending_embeddings`: число чанков с `embedded = 0`, отдельно от готовности embedding-провайдера.
- Размер батча и параллелизм embedding после изменения: переносятся из текущего кода (`96` чанков, параллелизм `2`, [src/indexing/embed-pending.ts:19](src/indexing/embed-pending.ts:19)).
