/**
 * Marks the current process as the dedicated ingestion worker.
 *
 * An environment variable rather than a DI token because it must be readable
 * before the Nest container exists -- `main.worker.ts` sets it as its very
 * first action, so the module graph it then builds sees it.
 *
 * Deliberately not part of the public config schema: it is an internal signal
 * about *which entrypoint is running*, not a user-facing setting. Putting it in
 * `.env` would invite someone to set it on an API process and quietly turn that
 * box back into a worker.
 */
const FLAG = 'KB_WORKER_PROCESS';

export function markWorkerProcess(): void {
  process.env[FLAG] = '1';
}

export function isWorkerProcess(): boolean {
  return process.env[FLAG] === '1';
}
