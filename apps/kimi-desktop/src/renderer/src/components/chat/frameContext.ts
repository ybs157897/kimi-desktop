/**
 * Turn context — the enclosing turn's lifecycle facts for frames that render
 * differently while a turn is live (streaming markdown cursor, "Thinking"
 * vs "Thought for {elapsed}" labels). Frames are leaf render units without a
 * back-reference to their turn, so TurnBlock provides this context instead of
 * widening the pinned frame props.
 */

import { createContext } from 'react';

import type { TurnState } from '@moonshot-ai/transcript';

export interface TurnContextValue {
  readonly state: TurnState;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
}

export const TurnContext = createContext<TurnContextValue | null>(null);
