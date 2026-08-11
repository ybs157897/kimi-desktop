import {
  Atom,
  FlowerLotus,
  Sparkle,
  Windmill,
} from '@phosphor-icons/react';

import { tagClasses, type TagKind } from '#/lib/agentColors';

export function SubagentGlyph({
  seed,
  tag,
  size = 'sm',
}: {
  readonly seed: string;
  readonly tag: TagKind;
  readonly size?: 'sm' | 'md';
}) {
  const icon = glyphIndex(seed);
  const iconSize = size === 'md' ? 14 : 12;
  const iconNode =
    icon === 0 ? (
      <Atom size={iconSize} weight="bold" aria-hidden />
    ) : icon === 1 ? (
      <FlowerLotus size={iconSize} weight="bold" aria-hidden />
    ) : icon === 2 ? (
      <Sparkle size={iconSize} weight="fill" aria-hidden />
    ) : (
      <Windmill size={iconSize} weight="bold" aria-hidden />
    );
  return (
    <span
      className={`${size === 'md' ? 'h-5 w-5' : 'h-4 w-4'} flex shrink-0 items-center justify-center rounded-full ${tagClasses(tag)}`}
      aria-hidden
    >
      {iconNode}
    </span>
  );
}

function glyphIndex(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 2_147_483_647;
  }
  return hash % 4;
}
