import type { Clock, RateLimitResult } from '../core/types.js';
import { SystemClock } from '../core/clock.js';
import type { FairShareLimiter } from './fair-share.js';

export interface WeightedFairShareOptions {
  /** Maximum total requests per window across all tenants */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Function that returns the weight for a given tenant */
  weightOf: (tenantId: string) => number;
  /** Clock for deterministic testing */
  clock?: Clock;
}

export interface WeightedFairShareLimiter extends FairShareLimiter {}

/**
 * Create a weighted max-min fair share limiter.
 *
 * Each active tenant receives a fair share proportional to their weight:
 *   fairCap = limit * (weightOf(tenantId) / totalWeight)
 */
export function weightedFairShare(options: WeightedFairShareOptions): WeightedFairShareLimiter {
  const { limit, windowMs, weightOf, clock = new SystemClock() } = options;

  let windowStart = clock.now();
  const usage = new Map<string, number>();

  function checkSync(tenantId: string): RateLimitResult {
    const now = clock.now();

    // Rotate window if expired
    if (now >= windowStart + windowMs) {
      usage.clear();
      windowStart = now;
    }

    // Compute total weight of all active tenants
    const activeTenantIds = Array.from(usage.keys());
    const totalWeight = activeTenantIds.reduce((sum, id) => sum + weightOf(id), 0);

    // Compute fair capacity for this tenant
    const tenantWeight = weightOf(tenantId);
    let fairCap: number;
    if (totalWeight === 0) {
      // First tenant gets full limit
      fairCap = limit;
    } else {
      fairCap = limit * (tenantWeight / totalWeight);
    }

    const currentUsage = usage.get(tenantId) ?? 0;
    const globalSum = Array.from(usage.values()).reduce((s, v) => s + v, 0);

    const allowed = currentUsage + 1 <= fairCap && globalSum + 1 <= limit;

    if (allowed) {
      usage.set(tenantId, currentUsage + 1);
    }

    const resetAt = windowStart + windowMs;
    const retryAfterMs = allowed ? 0 : resetAt - now;
    const remaining = Math.max(0, limit - (allowed ? globalSum + 1 : globalSum));

    return { allowed, limit, remaining, resetAt, retryAfterMs };
  }

  return {
    checkSync,
    check(tenantId: string): Promise<RateLimitResult> {
      return Promise.resolve(checkSync(tenantId));
    },
    reset(): void {
      usage.clear();
      windowStart = clock.now();
    },
  };
}

interface Tenant {
  index: number;
  demand: number;
  weight: number;
}

/**
 * Safely increment an array element, accounting for noUncheckedIndexedAccess.
 */
function increment(arr: number[], idx: number, val: number): void {
  arr[idx] = (arr[idx] ?? 0) + val;
}

/**
 * Get array element with a fallback, for use with noUncheckedIndexedAccess.
 */
function getAt(arr: readonly number[], idx: number): number {
  return arr[idx] ?? 0;
}

/**
 * Pure batch weighted max-min (water-filling) allocator.
 *
 * Distributes `budget` among tenants with given `demands` and `weights`.
 * Returns an array of allocations in the original input order.
 *
 * Properties:
 * - Output sums to exactly `budget` (or less if total demand < budget)
 * - Work-conserving: idle tenant's share flows to backlogged ones
 * - A tenant with zero demand gets zero allocation
 */
export function weightedMaxMin(demands: number[], weights: number[], budget: number): number[] {
  const n = demands.length;
  if (n === 0) return [];
  if (n !== weights.length) {
    throw new Error('demands and weights must have the same length');
  }

  // Handle zero budget or all-zero weights
  if (budget <= 0) return new Array<number>(n).fill(0);

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return new Array<number>(n).fill(0);

  // Create tenant objects
  const tenants: Tenant[] = demands.map((d, i) => ({
    index: i,
    demand: d,
    weight: weights[i] ?? 0,
  }));

  // Separate zero-weight tenants (they get 0 allocation)
  const positiveTenants = tenants.filter((t) => t.weight > 0);

  // Sort positive-weight tenants by demand/weight ratio ascending (water-filling order)
  positiveTenants.sort((a, b) => {
    const ratioA = a.demand / a.weight;
    const ratioB = b.demand / b.weight;
    return ratioA - ratioB;
  });

  const allocations = new Array<number>(n).fill(0);
  let remainingBudget = budget;

  // Phase 1: Water-filling - assign exact (floating point) allocations
  // We store floating point in exactAllocs
  const exactAllocs = new Array<number>(n).fill(0);
  let proportionalMode = false;

  for (let idx = 0; idx < positiveTenants.length && remainingBudget > 0; idx++) {
    const tenant = positiveTenants[idx]!;

    // Compute total weight of remaining unsatisfied tenants (including current)
    const remainingTenants = positiveTenants.slice(idx);
    const unsatisfiedWeight = remainingTenants.reduce((s, t) => s + t.weight, 0);

    if (unsatisfiedWeight <= 0) break;

    if (!proportionalMode) {
      // Water level (ratio) at which the current tenant would be satisfied
      const waterLevel = tenant.demand / tenant.weight;

      // Budget needed to bring ALL remaining tenants to this water level
      const neededBudget = waterLevel * unsatisfiedWeight;

      if (neededBudget <= remainingBudget) {
        // Current tenant (and earlier ones) can be fully satisfied
        exactAllocs[tenant.index] = tenant.demand;
        remainingBudget -= tenant.demand;
      } else {
        // Not enough budget to satisfy this tenant.
        // Enter proportional mode: distribute remaining budget proportionally
        proportionalMode = true;
        for (const t of remainingTenants) {
          exactAllocs[t.index] = (t.weight / unsatisfiedWeight) * remainingBudget;
        }
        remainingBudget = 0;
      }
    }
  }

  // Phase 2: Convert to integers with proper remainder distribution
  // Floor all allocations and track fractional parts
  interface FracEntry {
    index: number;
    frac: number;
  }
  const fracEntries: FracEntry[] = [];
  let sumFloor = 0;

  for (const t of positiveTenants) {
    const exact = getAt(exactAllocs, t.index);
    const floorVal = Math.floor(exact);
    const frac = exact - floorVal;
    allocations[t.index] = floorVal;
    sumFloor += floorVal;
    fracEntries.push({ index: t.index, frac });
  }

  // Distribute remaining budget based on fractional parts
  let remainder = budget - sumFloor;
  // Sort by fractional part descending
  fracEntries.sort((a, b) => b.frac - a.frac);

  for (const entry of fracEntries) {
    if (remainder <= 0) break;
    const current = getAt(allocations, entry.index);
    const tenant = tenants[entry.index]!;
    // Don't exceed demand
    if (current < tenant.demand) {
      increment(allocations, entry.index, 1);
      remainder -= 1;
    }
  }

  // If still remainder (due to integer precision issues), distribute 1-by-1
  if (remainder > 0) {
    const unsaturated = positiveTenants.filter((t) => getAt(allocations, t.index) < t.demand);
    while (remainder > 0) {
      let distributed = false;
      for (const t of unsaturated) {
        if (remainder <= 0) break;
        const current = getAt(allocations, t.index);
        if (current < t.demand) {
          increment(allocations, t.index, 1);
          remainder -= 1;
          distributed = true;
        }
      }
      if (!distributed) break; // all at capacity or budget exhausted
    }
  }

  return allocations;
}
