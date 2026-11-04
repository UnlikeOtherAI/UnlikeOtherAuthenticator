/** Settings streams share one serial database lane so fan-out cannot occupy both
 * admin connections. Admission bounds the number of producers; per-socket dirty
 * flags coalesce repeated notifications while a read is pending. */
export class SettingsStreamQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {});
    return result;
  }
}
