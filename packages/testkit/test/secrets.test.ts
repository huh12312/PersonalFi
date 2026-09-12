// SPDX-License-Identifier: MIT
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempSecretsDir } from './secrets.ts';

describe('withTempSecretsDir', () => {
  it('writes each secret to its own file, mode 0600', async () => {
    let seenDir = '';
    await withTempSecretsDir(
      { master_key: 'unit test passphrase', database_url: 'postgres://x/y' },
      async (dir) => {
        seenDir = dir;
        const masterKey = await readFile(join(dir, 'master_key'), 'utf8');
        expect(masterKey).toBe('unit test passphrase');
        const databaseUrl = await readFile(join(dir, 'database_url'), 'utf8');
        expect(databaseUrl).toBe('postgres://x/y');

        const mode = (await stat(join(dir, 'master_key'))).mode & 0o777;
        expect(mode).toBe(0o600);
      },
    );

    // Cleaned up once fn returns.
    await expect(access(seenDir)).rejects.toThrow();
  });

  it('cleans up even when fn throws', async () => {
    let seenDir = '';
    await expect(
      withTempSecretsDir({ master_key: 'x' }, async (dir) => {
        seenDir = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(access(seenDir)).rejects.toThrow();
  });

  it('returns whatever fn returns', async () => {
    const result = await withTempSecretsDir({ master_key: 'x' }, async (dir) => {
      return dir.length > 0;
    });
    expect(result).toBe(true);
  });
});
