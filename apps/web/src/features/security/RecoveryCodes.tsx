// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { downloadTextFile } from '../../lib/download-file.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { useGenerateRecoveryCodesMutation } from './api.ts';

export interface RecoveryCodesProps {
  /** The label of the button that generates (and, in Settings, replaces) the set. */
  readonly generateLabel: string;
  /** Called once the holder says the codes are saved. The codes are dropped from memory first. */
  readonly onSaved: () => void;
  readonly savedLabel: string;
}

function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}

/**
 * Generate the ten single-use recovery codes and show them once (F-13-5, WP 9.13).
 *
 * The server returns them exactly once and keeps only Argon2id hashes, so this component is the only place
 * they can be read: they live in its state, never the query cache, never storage, and are dropped when the
 * holder confirms they are saved. Generation is an explicit click and never an effect, because a second
 * call REPLACES the set, and a re-run effect would silently invalidate the codes already on screen.
 */
export function RecoveryCodes({ generateLabel, onSaved, savedLabel }: RecoveryCodesProps) {
  const generate = useGenerateRecoveryCodesMutation();
  const stepUp = useStepUpRetry();
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function run(): Promise<void> {
    setProblem(null);
    try {
      const result = await stepUp.run(() => generate.mutateAsync({}));
      setCodes(result.codes);
      setSaved(false);
      setCopied(false);
    } catch (cause) {
      if (stepUp.error === null)
        setProblem(problemDetail(cause, 'Could not create recovery codes.'));
    }
  }

  async function copy(): Promise<void> {
    if (codes === null) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setProblem(
        'Copying was blocked by the browser. Select the codes and copy them by hand, or download them.',
      );
    }
  }

  const failure = problem ?? stepUp.error;

  if (codes === null) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button
            type="button"
            onClick={() => void run()}
            disabled={generate.isPending || stepUp.busy}
          >
            {generate.isPending || stepUp.busy ? 'Working…' : generateLabel}
          </Button>
        </div>
        {failure !== null && (
          <p role="alert" className="text-small text-status-danger-text">
            {failure}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-secondary">
        Each code works once, in place of a passkey, if you lose every device. They are shown only
        now and cannot be shown again. Keep them somewhere that is not this computer.
      </p>
      <ol
        aria-label="Your recovery codes"
        className="grid grid-cols-1 gap-2 rounded-lg border border-border-hairline bg-bg-subtle p-3 sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>
            <code className="font-mono text-body text-text-primary">{code}</code>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            downloadTextFile(
              'personalfi-recovery-codes.txt',
              `PersonalFi recovery codes. Each works once.\n\n${codes.join('\n')}\n`,
              'text/plain',
            )
          }
        >
          Download as a text file
        </Button>
      </div>
      {failure !== null && (
        <p role="alert" className="text-small text-status-danger-text">
          {failure}
        </p>
      )}
      <label className="flex min-h-6 items-center gap-2 text-small text-text-primary">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        I have saved these codes somewhere safe
      </label>
      <div>
        <Button
          type="button"
          disabled={!saved}
          onClick={() => {
            setCodes(null);
            onSaved();
          }}
        >
          {savedLabel}
        </Button>
      </div>
    </div>
  );
}
