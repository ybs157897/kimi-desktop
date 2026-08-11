/**
 * CollapsibleBody — height-animated disclosure body (Codex `Mk` transition).
 *
 * Replaces the `{expanded ? <body/> : null}` unmount pattern so the open/close
 * motion is visible. The body stays mounted; the outer `motion.div` animates
 * height `0 ↔ auto` and clips overflow while closed, with `pointerEvents`
 * disabled so a collapsed body never intercepts clicks. The Codex disclosure
 * curve `[0.19, 1, 0.22, 1]` over 300 ms matches the reference app's
 * `Mk` transition. Under `prefers-reduced-motion` it snaps instantly.
 */

import { type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

export interface CollapsibleBodyProps {
  /** Whether the body is in the open (visible, full-height) state. */
  readonly open: boolean;
  readonly children: ReactNode;
  /** Optional max-height cap class (e.g. a reasoning chain caps at
   *  `max-h-[8.75rem]`); when set, the inner scroll container scrolls. */
  readonly maxHeightClass?: string;
  /** Extra className on the inner content wrapper. */
  readonly className?: string;
}

export function CollapsibleBody({ open, children, maxHeightClass, className }: CollapsibleBodyProps) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="collapsible-body"
      aria-hidden={open ? undefined : true}
      inert={!open}
      initial={false}
      animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.3, ease: [0.19, 1, 0.22, 1] }}
      style={{ overflow: 'hidden', pointerEvents: open ? 'auto' : 'none' }}
    >
      <div className={maxHeightClass ? `overflow-y-auto ${maxHeightClass} ${className ?? ''}` : (className ?? undefined)}>
        {children}
      </div>
    </motion.div>
  );
}
