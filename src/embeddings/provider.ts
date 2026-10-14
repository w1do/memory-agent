export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Used when no embedding endpoint is configured: semantic search is off, lexical keeps working. */
export class NullEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly reason: string, private readonly dims = 0) {}
  embed = async (): Promise<number[]> => { throw new Error(this.reason); };
  embedBatch = async (): Promise<number[][]> => { throw new Error(this.reason); };
  dimensions = () => this.dims;
  health = async () => ({ ok: false, detail: this.reason });
}
