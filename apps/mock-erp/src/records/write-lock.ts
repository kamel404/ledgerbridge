/**
 * Runs async tasks one at a time, in arrival order.
 *
 * A write reads records, checks rules, then saves. If two writes for the same
 * external ID ran interleaved, both could see "not found" and create two
 * records. Serialising writes prevents that in a single process.
 * (Across Lambda containers, the DynamoDB store will need conditional writes.)
 */
export class WriteLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    // `tail` never rejects (see the catch below), so one failed task
    // does not block the ones queued after it.
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
