// SPDX-License-Identifier: MIT
import { Avatar as BaseAvatar } from '@base-ui-components/react/avatar';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Merchant/institution logos are proxied and cached at our own origin
 * (05-frontend-architecture.md §2.6, §7.4) — never fetched from a bank CDN at
 * render time. `Fallback` is the monogram tile, coloured by the category
 * slot hash once that pipeline exists; for now a neutral tile.
 */
export function Avatar({ className, ...props }: ComponentProps<typeof BaseAvatar.Root>) {
  return (
    <BaseAvatar.Root
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-subtle',
        className,
      )}
      {...props}
    />
  );
}

export const AvatarImage = BaseAvatar.Image;

export function AvatarFallback({
  className,
  ...props
}: ComponentProps<typeof BaseAvatar.Fallback>) {
  return (
    <BaseAvatar.Fallback
      className={cn('text-caption font-medium text-text-secondary', className)}
      {...props}
    />
  );
}
