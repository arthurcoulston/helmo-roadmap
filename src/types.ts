// A project is durable where a ticket is disposable: it accumulates and gets
// rewritten over months, and it is never ready work — you claim its tickets,
// never the project itself (PRODUCT.md).

export const STATUSES = ['parked', 'shaping', 'ready', 'ship_next', 'shipping', 'shipped', 'abandoned'] as const;
export type Status = (typeof STATUSES)[number];

export const TERMINAL: readonly Status[] = ['shipped', 'abandoned'];

export const DEP_TYPES = ['blocks', 'relates'] as const;
export type DepType = (typeof DEP_TYPES)[number];

export const VALUE_LEVELS = ['high', 'medium', 'low'] as const;
export type ValueLevel = (typeof VALUE_LEVELS)[number];

export const EFFORT_SIZES = ['S', 'M', 'L', 'XL'] as const;
export type EffortSize = (typeof EFFORT_SIZES)[number];

export const HORIZONS = ['near', 'long', 'standing'] as const;
export type Horizon = (typeof HORIZONS)[number];

export const ACTOR_KINDS = ['agent', 'orchestrator', 'human'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  name: string;
  kind: ActorKind;
  model?: string;
  version?: string;
  session?: string;
}

/** A judgment is never a naked number: author, date, and a one-line reason
 *  ride with it, or the score decays into decoration (PRODUCT.md). */
export interface Claim {
  kind: 'value' | 'effort';
  level?: ValueLevel; // value claims
  size?: EffortSize; // effort claims
  predicted_usd?: number; // effort claims: the falsifiable dollar prediction
  reason: string;
  author: string;
  ts: string;
}

/** How a project advances an objective — checkable prose, not a weight. */
export interface Citation {
  objective_id: string;
  claim: string;
}

/** Charter projection: derived from the human's own document, never authored
 *  here. Objectives are dials (a project advances one); bets are claims about
 *  the world with a stake and a falsifier. Gates and stances are deliberately
 *  absent from v1 behavior — the shape vocabulary leaves them room. */
export interface Objective {
  id: string; // OBJ-n
  statement: string;
  horizon: Horizon;
  rank: number; // the human's ordering of the few durable things; 1 = top
  source: string; // pointer to the authoritative document
  derived_at: string;
}

export interface Bet {
  id: string; // BET-n
  statement: string;
  stake: string;
  falsifier: string;
  source: string;
  derived_at: string;
}

export interface Project {
  id: string; // R-n
  title: string;
  body: string;
  status: Status;
  parked_reason: string | null;
  unpark_condition: string | null; // parking carries its own exit
  actual_usd: number; // rolled up from Helmo tickets by the sweep, never self-reported
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Dep {
  from_id: string;
  to_id: string;
  type: DepType;
}

export interface Ranked {
  project: Project;
  rank: number; // 1-based position in the derived order
  explanation: string; // every rank explainable in one line
  blocked_by: string[];
  citations: Citation[];
  value: Claim | null; // latest value claim
  effort: Claim | null; // latest effort claim
}

export type EventType =
  | 'created' | 'updated' | 'claim_recorded' | 'cited' | 'uncited'
  | 'linked' | 'unlinked' | 'ship_next_set' | 'actual_recorded'
  | 'objective_set' | 'bet_set';

export interface RoadmapEvent {
  seq: number;
  ts: string;
  subject_id: string; // R-n, OBJ-n, or BET-n
  event_type: EventType;
  actor: Actor;
  payload: Record<string, unknown>;
}

export class RoadmapError extends Error {}
