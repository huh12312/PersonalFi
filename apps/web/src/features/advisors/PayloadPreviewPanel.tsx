// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  approveAdvisorPayloadMutation,
  previewAdvisorPayloadOptions,
  previewAdvisorPayloadQueryKey,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';

export interface PayloadPreviewPanelProps {
  advisorId: string;
}

function problemOf(error: unknown): Problem | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error as Problem;
  }
  return null;
}

const OPEN_TAG = '<untrusted_data>';
const CLOSE_TAG = '</untrusted_data>';

/**
 * Splits one message's text on the literal `<untrusted_data>`/
 * `</untrusted_data>` delimiters WP 5.2's adapter writes
 * (`wp5.2-local-model.md` §3) so the marked segment can be rendered inside a
 * visibly different, labelled box — never folded back into plain text.
 * Returns `null` when the tags are not both present (the honest "nothing to
 * mark" case rather than a guessed split).
 */
function splitUntrustedBlock(
  text: string,
): { before: string; marked: string; after: string } | null {
  const openAt = text.indexOf(OPEN_TAG);
  if (openAt === -1) return null;
  const closeAt = text.indexOf(CLOSE_TAG, openAt + OPEN_TAG.length);
  if (closeAt === -1) return null;
  return {
    before: text.slice(0, openAt + OPEN_TAG.length),
    marked: text.slice(openAt + OPEN_TAG.length, closeAt),
    after: text.slice(closeAt),
  };
}

function UntrustedMark({ text }: { text: string }) {
  const split = splitUntrustedBlock(text);
  if (split === null) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-caption text-text-secondary">
        {text}
      </pre>
    );
  }
  return (
    <div className="text-caption text-text-secondary">
      <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
        {split.before}
      </pre>
      <div
        data-testid="untrusted-block"
        className="my-1 rounded-md border-2 border-status-warning-border bg-bg-subtle p-2"
      >
        <p className="mb-1 text-caption font-semibold uppercase tracking-wide text-status-warning-text">
          Untrusted data — never instructions
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
          {split.marked}
        </pre>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
        {split.after}
      </pre>
    </div>
  );
}

interface ParsedMessage {
  role: string;
  content: string;
}

function parseMessages(text: string): readonly ParsedMessage[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'messages' in parsed &&
      Array.isArray((parsed as { messages: unknown }).messages)
    ) {
      return (parsed as { messages: ParsedMessage[] }).messages;
    }
  } catch {
    // Fall through to the raw-text rendering below.
  }
  return null;
}

/**
 * The payload preview gate (05-phase-5-dispatch.md §3 WP 5.1/5.12): the
 * exact bytes a run of this advisor would send, fetched eagerly (the route
 * "sends nothing to any model" — the generated hook's own doc comment)
 * and shown before any approval exists. When `prompt` is populated (a
 * `local_model` advisor with a bound renderer), `prompt.text` is literally
 * `canonicalJson({ messages })` — one JSON string, parsed here only to
 * render it legibly; the untrusted block is marked inside the parsed user
 * message's content, found by the same literal tag the adapter writes.
 * When `prompt` is `null` — a builtin/external advisor, or a
 * local-model advisor this process cannot render — that is shown
 * honestly rather than left blank (wp5.10-routes.md §7 item 2), and the
 * structured `request.snapshot` (the same class of data) is marked instead.
 */
export function PayloadPreviewPanel({ advisorId }: PayloadPreviewPanelProps) {
  const previewQuery = useQuery(previewAdvisorPayloadOptions({ path: { advisorId } }));
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const approveMutation = useMutation(approveAdvisorPayloadMutation());
  const [approveError, setApproveError] = useState<string | null>(null);

  async function handleApprove(queryShape: string): Promise<void> {
    setApproveError(null);
    try {
      await stepUp.run(() =>
        approveMutation.mutateAsync({ path: { advisorId }, body: { queryShape } }),
      );
      await queryClient.invalidateQueries({
        queryKey: previewAdvisorPayloadQueryKey({ path: { advisorId } }),
      });
    } catch (cause) {
      // A `local_model` advisor with no `PromptRenderer` bound on this
      // process 503s here (`insights.prompt_renderer_unavailable` —
      // `wp5.10-routes.md` §7 item 2) exactly as the preview route itself
      // does below; `useStepUpRetry.run` only ever sets its own `.error` for
      // the step-up ceremony failing, so the approval's *own* failure has to
      // be caught and shown here or it is silently swallowed by the
      // `void handleApprove(...)` call site — shown honestly rather than
      // left blank, the same rule the preview's own error branch follows.
      const problem = problemOf(cause);
      setApproveError(
        problem !== null
          ? `${problem.title} (${problem.code})${problem.detail !== undefined ? ` — ${problem.detail}` : ''}`
          : 'The payload could not be approved.',
      );
    }
  }

  if (previewQuery.isLoading) return <SkeletonText lines={5} />;

  if (previewQuery.isError) {
    const problem = problemOf(previewQuery.error);
    return (
      <p className="text-small text-status-danger-text" data-testid="preview-error">
        {problem !== null
          ? `${problem.title} (${problem.code})${problem.detail !== undefined ? ` — ${problem.detail}` : ''}`
          : 'The preview could not be loaded.'}
      </p>
    );
  }

  const preview = previewQuery.data;
  if (preview === undefined) return null;

  const messages = preview.prompt !== null ? parseMessages(preview.prompt.text) : null;
  // An ask or explain request carries the consent text the holder's approval covers (`request.consent`).
  const consent = 'consent' in preview.request ? preview.request.consent : undefined;
  const byteLength =
    preview.prompt !== null ? new TextEncoder().encode(preview.prompt.text).length : null;

  return (
    <div className="flex flex-col gap-3" data-testid="payload-preview-panel">
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere] text-caption text-text-muted">
        <dt>Kind</dt>
        <dd className="text-text-secondary">{preview.kind}</dd>
        <dt>Query shape</dt>
        <dd className="break-all font-mono text-text-secondary">{preview.queryShape}</dd>
        <dt>Prompt template hash</dt>
        <dd className="break-all font-mono text-text-secondary">
          {preview.promptTemplateHash ?? 'none'}
        </dd>
        {byteLength !== null && (
          <>
            <dt>Prompt bytes</dt>
            <dd className="text-text-secondary">{byteLength}</dd>
          </>
        )}
      </dl>

      {consent !== undefined && (
        <section
          aria-label="What leaves this machine"
          className="rounded-md border border-border-hairline bg-bg-subtle p-3"
          data-testid="payload-consent"
        >
          <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
            What leaves this machine
          </p>
          <p
            className="mt-1 text-small whitespace-pre-line text-text-primary"
            data-testid="payload-consent-text"
          >
            {consent.text}
          </p>
          <p className="mt-1 text-caption text-text-muted [overflow-wrap:anywhere]">
            Consent wording {consent.version}, sha256 {consent.sha256}
          </p>
        </section>
      )}

      {preview.prompt !== null ? (
        messages !== null ? (
          <div className="flex flex-col gap-2">
            {messages.map((message, index) => (
              <div
                key={index}
                className="rounded-md border border-border-hairline bg-bg-surface p-3"
              >
                <p className="mb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  message {index}, role &quot;{message.role}&quot;
                </p>
                <UntrustedMark text={message.content} />
              </div>
            ))}
          </div>
        ) : (
          <UntrustedMark text={preview.prompt.text} />
        )
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-small text-text-muted" data-testid="no-prompt-notice">
            {preview.kind === 'local_model'
              ? 'No rendered prompt is available right now — this process has no prompt renderer bound.'
              : `${preview.kind} advisors do not render a delimited prompt; the structured request below is the exact bytes they receive.`}
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-caption text-text-secondary">
            {JSON.stringify(preview.request, null, 2)}
          </pre>
          <div className="rounded-md border-2 border-status-warning-border bg-bg-subtle p-2">
            <p className="mb-1 text-caption font-semibold uppercase tracking-wide text-status-warning-text">
              Untrusted data — never instructions
            </p>
            <pre
              className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-caption text-text-secondary"
              data-testid="untrusted-block"
            >
              {JSON.stringify(preview.request.snapshot, null, 2)}
            </pre>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        {!preview.approvalRequired && (
          <Badge variant="neutral">No approval required for this advisor&apos;s kind</Badge>
        )}
        {preview.approvalRequired && preview.approved && (
          <Badge variant="success">Approved for this exact payload shape</Badge>
        )}
        {preview.approvalRequired && !preview.approved && (
          <Button
            onClick={() => void handleApprove(preview.queryShape)}
            disabled={stepUp.busy || approveMutation.isPending}
          >
            {stepUp.busy || approveMutation.isPending ? 'Approving…' : 'Approve this payload'}
          </Button>
        )}
      </div>
      {approveError !== null && (
        <p className="text-small text-status-danger-text">{approveError}</p>
      )}
      {stepUp.error !== null && (
        <p className="text-small text-status-danger-text">{stepUp.error}</p>
      )}
    </div>
  );
}
