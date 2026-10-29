// SPDX-License-Identifier: MIT
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { TalkThroughLink } from '../advisor/TalkThroughLink.tsx';
import { BriefProgressBox } from './BriefProgressBox.tsx';
import { EvidencePanel } from '../insights/EvidencePanel.tsx';
import { insightViewOf } from './evidence-adapter.ts';
import type { BriefItemWithNarration } from './types.ts';

export interface AttentionStripProps {
  items: readonly BriefItemWithNarration[];
}

function AttentionStripRow({ item }: { item: BriefItemWithNarration }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="rounded-md border border-status-warning-border bg-bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={item.severity} />
        <h3 className="text-body font-medium text-text-primary">{item.title}</h3>
      </div>
      <p className="mt-1 text-small text-text-secondary">{item.summaryMd}</p>
      {item.progress !== null && <BriefProgressBox progress={item.progress} />}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="min-h-6 rounded-sm text-small text-accent-text hover:underline focus-visible:outline-none"
        >
          {expanded ? 'Hide evidence panel' : 'Why am I seeing this?'}
        </button>
        {item.talkThrough !== null && item.progress === null && (
          <TalkThroughLink
            insightId={item.talkThrough.insightId}
            briefWeek={item.talkThrough.briefWeek}
          />
        )}
      </div>
      {expanded && (
        <div className="mt-2">
          <EvidencePanel insight={insightViewOf(item)} />
        </div>
      )}
    </li>
  );
}

/**
 * Urgent findings with no dollar figure (an overdraft ahead, a duplicate
 * charge, a missed payment) — above the five ranked cards, never competing
 * for one of their slots and never dropped by a key tie-break
 * (05-phase-5-dispatch.md §3 WP 5.6/5.11).
 */
export function AttentionStrip({ items }: AttentionStripProps) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="attention-strip-heading" data-testid="attention-strip">
      <h2
        id="attention-strip-heading"
        className="mb-2 flex items-center gap-2 text-h3 text-text-primary"
      >
        <AlertTriangle size={18} aria-hidden="true" className="text-status-warning-text" />
        Needs attention
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <AttentionStripRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}
