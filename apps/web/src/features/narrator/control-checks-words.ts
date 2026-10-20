// SPDX-License-Identifier: MIT
/**
 * Settings › Language model › Control checks, in words (WP 10.16). Pure functions over the
 * `GET /narrator/control-checks` shape, so every sentence the section can say is tested without rendering, and no
 * state is ever carried by colour alone: a check's result is always a word ("Pass", "Skipped", "Not applicable"),
 * a run's result is always a word ("Pass", "Partial: some checks could not run", "Interrupted").
 */
import { format } from 'date-fns';

import type { ControlCheckRun, ControlCheckRuns } from '../../api/generated/types.gen.ts';

export type { ControlCheckRun, ControlCheckRuns };
export type ControlCheckRow = ControlCheckRun['results'][number];
export type ControlCheckStatus = ControlCheckRow['status'];
export type ControlCheckProvider = ControlCheckRun['provider'];

/** How many checks a run always has (the api's `CONTROL_CHECK_IDS`). */
export const CONTROL_CHECK_COUNT = 11;

/** What the Result column reads. A skip that is a property of the provider reads "Not applicable". */
export function checkStatusWord(row: Pick<ControlCheckRow, 'status' | 'notApplicable'>): string {
  switch (row.status) {
    case 'pass':
      return 'Pass';
    case 'fail':
      return 'Fail';
    case 'skipped':
      return row.notApplicable ? 'Not applicable' : 'Skipped';
    case 'reported':
      return 'Reported';
    case 'running':
      return 'Running';
    case 'pending':
      return 'Pending';
    default:
      return String(row.status);
  }
}

/** A check that has an outcome (anything but pending or running). */
export function isSettled(row: Pick<ControlCheckRow, 'status'>): boolean {
  return row.status !== 'pending' && row.status !== 'running';
}

/** The run's result in words: "Pass", "Fail", "Partial: some checks could not run", "Interrupted", "Running". */
export function runResultWords(run: Pick<ControlCheckRun, 'state' | 'overall'>): string {
  if (run.state === 'interrupted') return 'Interrupted';
  if (run.state === 'running') return 'Running';
  switch (run.overall) {
    case 'pass':
      return 'Pass';
    case 'fail':
      return 'Fail';
    case 'partial':
      return 'Partial: some checks could not run';
    default:
      return 'No result';
  }
}

/** "1.2 s", "0.0 s", "1 min 5 s"; "—" when the check was not timed. */
export function formatCheckDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)} min ${String(seconds)} s`;
}

/** "19 Oct 2026, 14:22", in the holder's own time zone. */
export function formatRunTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format(date, 'd MMM yyyy, HH:mm');
}

/** "14:32" (the same day) or "20 Oct, 09:05", in the holder's own time zone. */
export function formatClock(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = format(date, 'yyyy-MM-dd') === format(now, 'yyyy-MM-dd');
  return sameDay ? format(date, 'HH:mm') : format(date, 'd MMM, HH:mm');
}

const PROVIDER_NAMES: Readonly<Record<ControlCheckProvider, string>> = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  off: 'Off',
};

/**
 * The provider and model a run used, in words: "Anthropic, claude-sonnet-5-5", "Ollama (local),
 * qwen2.5:7b-instruct-q4_K_M at sha256:3f3f3f3f3f3f…", "Off (no model)". The api sends `provider:model` for a hosted
 * provider and `name@sha256:…` for the local model; the prefix is dropped and a digest shortened to 12 characters.
 */
export function providerModelWords(provider: ControlCheckProvider, model: string | null): string {
  const name = PROVIDER_NAMES[provider];
  if (provider === 'off') return 'Off (no model)';
  if (model === null || model === '') return name;
  let shown = model.startsWith(`${provider}:`) ? model.slice(provider.length + 1) : model;
  const at = shown.indexOf('@sha256:');
  if (at >= 0) {
    const digest = shown.slice(at + '@sha256:'.length);
    shown = `${shown.slice(0, at)} at sha256:${digest.slice(0, 12)}${digest.length > 12 ? '…' : ''}`;
  }
  return `${name}, ${shown}`;
}

/** The live region's sentence while a run is going: "4 of 11 checks done." */
export function progressWords(run: Pick<ControlCheckRun, 'results'>): string {
  const done = run.results.filter(isSettled).length;
  const total = run.results.length === 0 ? CONTROL_CHECK_COUNT : run.results.length;
  return `${String(done)} of ${String(total)} checks done.`;
}

/** "8 passed, 1 failed, 2 skipped, 1 reported" (only the counts that are not zero). */
export function tallyWords(run: Pick<ControlCheckRun, 'results'>): string {
  const count = (predicate: (row: ControlCheckRow) => boolean) =>
    run.results.filter(predicate).length;
  const parts: Array<[number, string]> = [
    [count((r) => r.status === 'pass'), 'passed'],
    [count((r) => r.status === 'fail'), 'failed'],
    [count((r) => r.status === 'skipped' && !r.notApplicable), 'skipped'],
    [count((r) => r.status === 'skipped' && r.notApplicable), 'not applicable'],
    [count((r) => r.status === 'reported'), 'reported'],
    [count((r) => !isSettled(r)), 'not finished'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${String(n)} ${word}`)
    .join(', ');
}

/** The sentence once a run is done: "Finished 19 Oct 2026, 14:22. Result: Pass. 10 passed, 1 reported." */
export function doneWords(run: ControlCheckRun): string {
  const when = run.finishedAt ?? run.startedAt;
  const lead =
    run.state === 'interrupted'
      ? `Started ${formatRunTime(run.startedAt)} and interrupted before it finished.`
      : `Finished ${formatRunTime(when)}.`;
  const tally = tallyWords(run);
  return `${lead} Result: ${runResultWords(run)}.${tally === '' ? '' : ` ${tally}.`}`;
}

/** Why the button is unavailable, or `null` when it is not: "You can run the checks again at 14:32." */
export function nextAllowedWords(nextAllowedAt: string | null, now: Date): string | null {
  if (nextAllowedAt === null) return null;
  const at = new Date(nextAllowedAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
  return `You can run the checks again at ${formatClock(nextAllowedAt, now)}.`;
}
