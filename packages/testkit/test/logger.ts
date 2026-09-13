// SPDX-License-Identifier: MIT
import type { PlatformLogger } from '@core/platform';

/**
 * A logger that records what it was told, for asserting on warn/error paths.
 *
 * `extends PlatformLogger` rather than re-declaring the four methods: the whole
 * point of the recorder is to be passed wherever a real logger goes, so a
 * signature drift should be a compile error here rather than at every call site.
 */
export interface RecordingLogger extends PlatformLogger {
  readonly lines: Array<{ level: string; obj: Record<string, unknown>; msg: string | undefined }>;
}

export function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger['lines'] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      lines.push({ level, obj, msg });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    lines,
  };
}
