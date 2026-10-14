export class MemoryError extends Error {
  constructor(message: string, readonly code: string = 'memory_error') {
    super(message);
    this.name = 'MemoryError';
  }
}

export class PathOutsideProjectError extends MemoryError {
  constructor(path: string) {
    super(`Path is outside the project root: ${path}`, 'path_outside_project');
  }
}

export class SemanticUnavailableError extends MemoryError {
  constructor(reason: string) {
    super(`semantic_search_unavailable: ${reason}`, 'semantic_search_unavailable');
  }
}
