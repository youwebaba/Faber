import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openStore(directory, initial) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read harness state: ${error.message}`); state = initial; }
  let queue = Promise.resolve();
  return {
    state,
    save(value) {
      const json = JSON.stringify(value, null, 2);
      const operation = queue.then(async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, json, { mode: 0o600, flush: true });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    flush() { return queue; },
  };
}
