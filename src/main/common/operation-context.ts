export interface OperationProgress {
  /** Includes work that may still be in flight or need to be repeated. */
  processedBytes: number;
  /** Only backend acknowledgements can contribute to a recovery checkpoint. */
  confirmedBytes?: number;
  totalBytes?: number;
}

export interface OperationContext {
  signal?: AbortSignal;
  correlationId?: string;
  onProgress?: (progress: OperationProgress) => void;
}
