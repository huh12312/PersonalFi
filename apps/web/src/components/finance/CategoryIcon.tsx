// SPDX-License-Identifier: MIT
import { cn } from '../../lib/cn.ts';
import { categoryGlyph, iconHue, iconRoles, type CategoryIconSource } from './category-icon.ts';

export type CategoryIconSize = 'xs' | 'sm' | 'md';

const SIZE_CLASS: Record<
  CategoryIconSize,
  { readonly box: string; readonly emoji: string; readonly initials: string }
> = {
  xs: { box: 'h-6 w-6', emoji: 'text-[13px]', initials: 'text-[10px]' },
  sm: { box: 'h-8 w-8', emoji: 'text-[17px]', initials: 'text-[11px]' },
  md: { box: 'h-12 w-12', emoji: 'text-[26px]', initials: 'text-[15px]' },
};

export interface CategoryIconProps {
  readonly category: CategoryIconSource;
  readonly size?: CategoryIconSize;
  /** Draw "+" instead of a glyph: the folded "Other (n …)" row of a breakdown. */
  readonly folded?: boolean;
  readonly className?: string;
}

/**
 * A category's icon in a circle tinted by its hue (WP 10.14, V7; Monarch's emoji `Category.icon` in a hue-washed
 * circle). The glyph is the holder's emoji, the system default for the key, or the initials (`categoryGlyph`).
 *
 * **Decorative**: `aria-hidden`, always beside the category's name, which is the accessible label — an emoji's own
 * name ("shopping cart") read before "Groceries" would be noise, and colour is identity only, never meaning.
 */
export function CategoryIcon({
  category,
  size = 'sm',
  folded = false,
  className,
}: CategoryIconProps) {
  const glyph = categoryGlyph(category);
  const roles = iconRoles(iconHue(category));
  const sizes = SIZE_CLASS[size];
  const isEmoji = !folded && glyph.kind === 'emoji';
  return (
    <span
      aria-hidden="true"
      data-category-icon={category.id ?? 'none'}
      data-glyph={folded ? 'folded' : glyph.kind === 'emoji' ? `emoji-${glyph.source}` : 'initials'}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full leading-none',
        sizes.box,
        isEmoji ? sizes.emoji : cn(sizes.initials, 'font-semibold'),
        className,
      )}
      style={{ background: roles.background, color: roles.color }}
    >
      {folded ? '+' : glyph.text}
    </span>
  );
}
