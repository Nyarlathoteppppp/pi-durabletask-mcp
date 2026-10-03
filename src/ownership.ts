import { chmodSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Exclusive ownership of durable jobs, backed by SQLite's POSIX file locks. The kernel drops a
 * lock when its process dies, so ownership needs no PID check and survives PID reuse. A stopped
 * or hung owner keeps its lock and is never taken over; kill it to release its jobs.
 *
 * Lock files are touched only here, only through node:sqlite. Closing any other descriptor of
 * a lock file in this process would drop the process's POSIX locks on it. Lock files are never
 * deleted: unlinking an open lock lets the next opener lock a new inode at the same path.
 * STATE_DIR must be on a local filesystem; network filesystems may not honour these locks.
 */
const held = new Map<string, DatabaseSync>();
let directory: string | undefined;

export function initOwnership(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  directory = dir;
}

export const owns = (key: string): boolean => held.has(key);

/** False when another connection, in this process or another, holds the lock. */
export function tryAcquire(key: string): boolean {
  if (!directory) throw new Error("Ownership directory is not initialised");
  if (held.has(key)) return false;
  const path = join(directory, `${key}.sqlite`);
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) return false;
    throw error;
  }
  chmodSync(path, 0o600);
  held.set(key, lock);
  return true;
}

export function release(key: string): void {
  held.get(key)?.close();
  held.delete(key);
}

/**
 * Delete lock files of jobs that no longer exist. Each is deleted while locked, so nobody holds
 * the old inode; a claimer that opens the path afterwards finds no catalog row and lets go.
 */
export function removeTombstones(exists: (key: string) => boolean): void {
  if (!directory) return;
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".sqlite")) continue;
    const key = file.slice(0, -".sqlite".length);
    if (exists(key) || !tryAcquire(key)) continue;
    try { if (!exists(key)) unlinkSync(join(directory, file)); } finally { release(key); }
  }
}
