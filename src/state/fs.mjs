// Atomic writes on the same filesystem. Durable files are never truncated in
// place: write a unique temp beside the target, then rename.
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function atomicWriteFile(path, contents, { encoding = 'utf8' } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, contents, encoding);
  renameSync(tmp, path);
  return path;
}

export function atomicWriteJson(path, value) {
  return atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const error = new Error(`${path} is not valid JSON (${err.message})`);
    error.cause = err;
    error.path = path;
    throw error;
  }
}

export function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
