// SPDX-License-Identifier: MIT
import { isInAppHref } from '@core/kernel';
import { useRouter } from '@tanstack/react-router';
import type { MouseEvent, ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface BlockLinkProps {
  /** A block's href: followed only when it is an in-app path (`isInAppHref`); anything else renders as text. */
  readonly href: string | undefined;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * The link's accessible name when the visible text is not enough ("transactions in Groceries" for a visible
   * "transactions"). It must contain the visible text (WCAG 2.5.3, label in name).
   */
  readonly srLabel?: string;
  readonly testId?: string;
}

const LINK = 'text-accent-text underline-offset-4 hover:underline';

/**
 * The one link a block draws (WP 10.15). A real `<a href>` — so it opens in a new tab, copies, and is announced as a
 * link — whose plain click is handed to the router (`navigate({ href })`), so following it is an in-app navigation
 * rather than a page load. An href that is not an in-app path (a scheme, a host, `//`, a backslash) is never a link:
 * the schema refuses it on both sides, and this refuses it again, so a block can only ever point inside the SPA.
 */
export function BlockLink({ href, children, className, srLabel, testId }: BlockLinkProps) {
  const router = useRouter();
  if (href === undefined || !isInAppHref(href)) {
    return (
      <span className={className} data-testid={testId} data-block-link-refused={href ?? ''}>
        {children}
      </span>
    );
  }
  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void router.navigate({ href });
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className={cn(LINK, className)}
      data-testid={testId}
      {...(srLabel === undefined ? {} : { 'aria-label': srLabel })}
    >
      {children}
    </a>
  );
}
