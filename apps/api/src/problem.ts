// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * RFC 9457 Problem Details.
 *
 * The frontend switches on `type` and `code`, never on `detail`: user-facing copy
 * gets rewritten a dozen times and must not be load-bearing. `type` is a stable
 * URI under our own namespace; it is documentation, not a live URL.
 */
export const PROBLEM_TYPE_BASE = 'https://personalfi.local/problems';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const problemSchema = z
  .object({
    type: z.string().describe('Stable URI identifying the problem kind.'),
    title: z.string().describe('Short, human-readable summary. Does not change per occurrence.'),
    status: z.number().int().describe('HTTP status code.'),
    detail: z.string().optional().describe('Explanation specific to this occurrence.'),
    instance: z.string().optional().describe('URI of the specific occurrence.'),
    code: z.string().describe('Stable machine code the client switches on.'),
    correlationId: z.string().describe('Quote this when reporting the failure.'),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('Field-level validation failures.'),
  })
  .meta({ id: 'Problem', description: 'RFC 9457 problem details.' });

export type Problem = z.infer<typeof problemSchema>;

/**
 * The `response` entries for a route's error statuses.
 *
 * `{ 200: body, ...problems(401, 429, 503) }` instead of three identical
 * `problemSchema` lines: every failure in this application serialises to the
 * same RFC 9457 body, so the only thing a route actually decides is *which*
 * statuses it can produce. Spelling that as a list makes a missing status
 * visible and a copy-pasted one impossible.
 */
export function problems<const TStatuses extends readonly number[]>(
  ...statuses: TStatuses
): { [K in TStatuses[number]]: typeof problemSchema } {
  return Object.fromEntries(statuses.map((status) => [status, problemSchema])) as {
    [K in TStatuses[number]]: typeof problemSchema;
  };
}

/**
 * The four error families (08 §6.4). An unrecognised exception is `internal`:
 * fail closed, never leak internals.
 */
export type ErrorFamily = 'user' | 'domain' | 'connector' | 'internal';

export interface AppErrorOptions {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly family: ErrorFamily;
  readonly errors?: ReadonlyArray<{ path: string; message: string }>;
}

/** Anything thrown deliberately by a route. Carries its own HTTP mapping. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly family: ErrorFamily;
  readonly errors: ReadonlyArray<{ path: string; message: string }> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.detail ?? options.title);
    this.name = 'AppError';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.family = options.family;
    this.errors = options.errors;
  }
}

export function serviceUnavailable(code: string, detail: string): AppError {
  return new AppError({
    status: 503,
    code,
    title: 'Service Unavailable',
    detail,
    family: 'internal',
  });
}

export function toProblem(
  error: unknown,
  correlationId: string,
  instance: string,
): { problem: Problem; family: ErrorFamily } {
  if (error instanceof AppError) {
    return {
      family: error.family,
      problem: {
        type: `${PROBLEM_TYPE_BASE}/${error.code}`,
        title: error.title,
        status: error.status,
        detail: error.message,
        instance,
        code: error.code,
        correlationId,
        ...(error.errors === undefined ? {} : { errors: [...error.errors] }),
      },
    };
  }

  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = String((error as { code?: unknown }).code ?? 'request_invalid').toLowerCase();
    return {
      family: 'user',
      problem: {
        type: `${PROBLEM_TYPE_BASE}/${code}`,
        title: status === 404 ? 'Not Found' : 'Bad Request',
        status,
        detail: (error as Error).message,
        instance,
        code,
        correlationId,
      },
    };
  }

  // Unknown shape: say nothing about it beyond an id the operator can grep for.
  return {
    family: 'internal',
    problem: {
      type: `${PROBLEM_TYPE_BASE}/internal_error`,
      title: 'Internal Server Error',
      status: 500,
      detail: 'The request could not be completed. Quote the correlation id when reporting this.',
      instance,
      code: 'internal_error',
      correlationId,
    },
  };
}
