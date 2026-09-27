'use client';

import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * One place for motion policy.
 *
 * `reducedMotion="user"` makes every transform animation below respect the OS
 * setting, leaving only opacity. `strict` forbids the full `motion.*`
 * components, so nothing can pull the whole library back into the bundle.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: EASE_OUT }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

/** Strong ease-out: responds immediately, settles softly. Never ease-in for UI. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export const SPRING = { type: 'spring', duration: 0.35, bounce: 0.15 } as const;

/** Enter from slightly below. Small distances; a 6px rise reads as arrival, 40px as a slide. */
export const riseIn = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;
