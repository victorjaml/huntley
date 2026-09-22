// Exclusive single-writer lock under the data directory.
//
// Created with O_EXCL so a second process cannot steal it. A leftover file is
// recovered only when its owning pid is verifiably gone. Corrupt or ambiguous
// lock files fail closed — never silently reset history.
import { openSync, writeFileSync, closeSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:fs';

const heldByThisProcess = new Map();

function lockPath(dataDir) {
  return join(dataDir, '.huntley.lock');
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we cannot signal it. Treat as alive.
    return err?.code === 'EPERM';
  }
}

function readLockFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Could not read lock file ${path} (${err.message}). If no huntley process is running, delete the file and retry.`);
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') throw new Error('not an object');
    return doc;
  } catch {
    throw new Error(`Lock file ${path} is corrupt. If no huntley process is running, delete it and retry.`);
  }
}

function writeExclusive(path, payload) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  try {
    writeFileSync(fd, `${JSON.stringify(payload)}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} dataDir
 * @returns {{path: string, release: () => void}}
 */
export function acquireLock(dataDir) {
  const path = lockPath(dataDir);
  const payload = { pid: process.pid, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeExclusive(path, payload);
      const handle = {
        path,
        release() {
          if (heldByThisProcess.get(dataDir) !== handle) return;
          heldByThisProcess.delete(dataDir);
          try { if (existsSync(path)) unlinkSync(path); } catch { /* already gone */ }
        },
      };
      heldByThisProcess.set(dataDir, handle);
      return handle;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existing = readLockFile(path);
      const pid = Number(existing.pid);
      const oursUnheld = pid === process.pid && !heldByThisProcess.has(dataDir);
      if (!isProcessAlive(pid) || oursUnheld) {
        try { unlinkSync(path); } catch { /* raced */ }
        continue;
      }
      throw new Error(
        `Another huntley process is running (pid ${pid}, lock ${path}). `
        + `Wait for it to finish. If that process is dead, delete the lock file and retry.`,
      );
    }
  }
  throw new Error(`Could not acquire ${path} after recovering a stale lock. Retry.`);
}

export function lockFilePath(dataDir) {
  return lockPath(dataDir);
}
