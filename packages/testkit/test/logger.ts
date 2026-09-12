// SPDX-License-Identifier: MIT

/** A logger that records what it was told, for asserting on warn/error paths. */
export interface RecordingLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
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
