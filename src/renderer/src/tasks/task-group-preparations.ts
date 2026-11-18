interface PreparationJob {
  controller: AbortController;
  run(signal: AbortSignal): Promise<void>;
  done: Promise<void>;
  resolve(): void;
}

/** Preparation work has its own bounded capacity and never consumes task slots. */
export class TaskGroupPreparations {
  private readonly pending: PreparationJob[] = [];
  private readonly active = new Set<PreparationJob>();
  private closed = false;

  enqueue(run: PreparationJob['run']): void {
    if (this.closed) return;
    let resolve!: () => void;
    const done = new Promise<void>((finish) => {
      resolve = finish;
    });
    this.pending.push({ controller: new AbortController(), run, done, resolve });
    this.drain();
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const queued = this.pending.splice(0);
    const jobs = [...queued, ...this.active];
    for (const job of jobs) job.controller.abort();
    for (const job of queued) this.start(job);
    await Promise.all(jobs.map((job) => job.done));
  }

  private drain(): void {
    if (this.closed) return;
    while (this.active.size < 4 && this.pending.length) this.start(this.pending.shift()!);
  }

  private start(job: PreparationJob): void {
    this.active.add(job);
    void job
      .run(job.controller.signal)
      .catch(() => {
        console.error('Task group preparation callback failed.');
      })
      .finally(() => {
        this.active.delete(job);
        job.resolve();
        this.drain();
      });
  }
}
