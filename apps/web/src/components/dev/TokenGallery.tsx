// SPDX-License-Identifier: MIT
import type { CSSProperties } from 'react';

import { CHART_FILL_ORDER } from '../../styles/tokens/fills.ts';
import { chartEventVar, chartFillVar } from '../finance/chart-hue.ts';

/**
 * `/dev/kitchen-sink`'s "Tokens" section (WP 10.8): the thirteen chart fills with their four event roles, the
 * four status quartets, and the surface and text roles — rendered from the roles themselves, in whichever theme
 * the enclosing `data-theme` panel sets. Text is drawn only on surfaces that are text surfaces
 * (`docs/design/tokens.md`); `--bg-tertiary` and `--bg-inset` are labelled beside their swatch, not on it.
 */
const SURFACES = ['page', 'primary', 'secondary', 'tertiary', 'inset', 'overlay'] as const;
const TEXT = ['primary', 'secondary', 'tertiary', 'muted'] as const;
const STATUSES = ['success', 'danger', 'warning', 'info'] as const;

const v = (name: string): string => `var(--${name})`;

export function TokenGallery() {
  return (
    <div className="flex flex-col gap-6" data-testid="token-gallery">
      <div>
        <h3 className="mb-2 text-small text-text-secondary">
          Chart fills and events (validated order)
        </h3>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          {CHART_FILL_ORDER.map((hue) => (
            <li
              key={hue}
              className="flex flex-col gap-2 rounded-md border border-border-hairline bg-bg-surface p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-6 w-10 rounded-sm"
                  style={{ background: chartFillVar(hue) }}
                />
                <span className="text-caption text-text-secondary">{hue}</span>
              </div>
              <span
                className="inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption"
                style={
                  {
                    background: chartEventVar('bg', hue),
                    borderColor: chartEventVar('border', hue),
                    color: chartEventVar('fg', hue),
                  } satisfies CSSProperties
                }
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-2 rounded-full"
                  style={{ background: chartEventVar('dot', hue) }}
                />
                Event
              </span>
            </li>
          ))}
          <li className="flex items-center gap-2 rounded-md border border-border-hairline bg-bg-surface p-3">
            <span
              aria-hidden="true"
              className="inline-block h-6 w-10 rounded-sm"
              style={{ background: chartFillVar('neutral') }}
            />
            <span className="text-caption text-text-secondary">neutral</span>
          </li>
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-small text-text-secondary">Status quartets</h3>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {STATUSES.map((status) => (
            <li
              key={status}
              className="flex flex-col gap-2 rounded-md border p-3"
              style={{
                background: v(`status-${status}-bg`),
                borderColor: v(`status-${status}-border`),
              }}
            >
              <span
                className="text-small font-medium"
                style={{ color: v(`status-${status}-text`) }}
              >
                {status} text
              </span>
              <span
                aria-hidden="true"
                className="block h-2 rounded-full"
                style={{ background: v(`status-${status}-bold`) }}
              />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-small text-text-secondary">Surfaces</h3>
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {SURFACES.map((surface) => (
            <li key={surface} className="flex flex-col gap-1">
              <span
                aria-hidden="true"
                className="block h-12 rounded-md border border-border-hairline"
                style={{ background: v(`bg-${surface}`) }}
              />
              <span className="text-caption text-text-muted">bg-{surface}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-small text-text-secondary">Text and borders</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['primary', 'secondary', 'overlay'] as const).map((surface) => (
            <div
              key={surface}
              className="flex flex-col gap-1 rounded-md p-3"
              style={{ background: v(`bg-${surface}`), border: `1px solid ${v('border-primary')}` }}
            >
              <span className="text-caption text-text-muted">on bg-{surface}</span>
              {TEXT.map((text) => (
                <span key={text} className="text-small" style={{ color: v(`text-${text}`) }}>
                  text-{text}
                </span>
              ))}
            </div>
          ))}
          <div className="flex flex-col gap-2 rounded-md bg-bg-surface p-3">
            {(['primary', 'secondary', 'divider'] as const).map((border) => (
              <div key={border} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="block h-0 w-16"
                  style={{ borderTop: `2px solid ${v(`border-${border}`)}` }}
                />
                <span className="text-caption text-text-muted">border-{border}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
