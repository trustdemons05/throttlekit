import type { StrategyFn, StrategyResult, Clock } from '../core/types.js';

export type { StrategyFn, StrategyResult };

export interface StrategyConfig {
  clock: Clock;
}
