// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { recordingLogger } from './logger.ts';

describe('recordingLogger', () => {
  it('records each level with its object and message', () => {
    const logger = recordingLogger();
    logger.info({ a: 1 }, 'hello');
    logger.warn({ b: 2 });
    logger.error({ c: 3 }, 'boom');
    logger.debug({ d: 4 }, 'trace me');

    expect(logger.lines).toEqual([
      { level: 'info', obj: { a: 1 }, msg: 'hello' },
      { level: 'warn', obj: { b: 2 }, msg: undefined },
      { level: 'error', obj: { c: 3 }, msg: 'boom' },
      { level: 'debug', obj: { d: 4 }, msg: 'trace me' },
    ]);
  });
});
