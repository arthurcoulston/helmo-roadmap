import Database from 'better-sqlite3';
import {
  Actor, Bet, Citation, Claim, Dep, DepType, EFFORT_SIZES, Horizon, Objective,
  Project, Ranked, RoadmapError, RoadmapEvent, Status, TERMINAL, VALUE_LEVELS,
} from './types.js';

export interface CreateInput {
  title: string;
  body?: string; // a title and a sentence — any required field would strangle the backlog at birth
  status?: 'parked' | 'shaping';
}

export interface UpdateInput {
  project_id: string;
  note: string;
  status?: Exclude<Status, 'ship_next'>; // ship_next only via setShipNext — it is the human's call
  title?: string;
  body?: string;
  parked_reason?: string;
  unpark_condition?: string;
}

export interface UpdateResult {
  project: Project;
  warnings: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor      TEXT NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_id);
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'parked',
  parked_reason    TEXT,
  unpark_condition TEXT,
  actual_usd       REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT
);
CREATE TABLE IF NOT EXISTS deps (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  type    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE TABLE IF NOT EXISTS claims (
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  level         TEXT,
  size          TEXT,
  predicted_usd REAL,
  reason        TEXT NOT NULL,
  author        TEXT NOT NULL,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE TABLE IF NOT EXISTS citations (
  project_id   TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  claim        TEXT NOT NULL,
  PRIMARY KEY (project_id, objective_id)
);
CREATE TABLE IF NOT EXISTS objectives (
  id         TEXT PRIMARY KEY,
  statement  TEXT NOT NULL,
  horizon    TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  source     TEXT NOT NULL,
  derived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bets (
  id         TEXT PRIMARY KEY,
  statement  TEXT NOT NULL,
  stake      TEXT NOT NULL,
  falsifier  TEXT NOT NULL,
  source     TEXT NOT NULL,
  derived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function now(): string {
  return new Date().toISOString();
}

function validateActor(actor: Actor): void {
  if (!actor?.name || !actor?.kind) {
    throw new RoadmapError(
      'No actor identity. Configure ROADMAP_ACTOR (JSON with at least {"name", "kind"}) in the MCP server environment, or pass an "actor" param. Provenance requires knowing who writes.',
    );
  }
  if (actor.kind === 'agent' && (!actor.model || !actor.version)) {
    throw new RoadmapError(
      `Actor "${actor.name}" has kind "agent" but is missing model and/or version. Agents must identify their model ID and harness version — this is what makes corrections verifiable.`,
    );
  }
}

// Same hazard as Helmo's H-71: a mis-serialized tool call dumps parameter
// markup — and every field after the break — into the first free-text field.
const TOOLCALL_MARKUP = /<\/?([a-z]+:)?(parameter|invoke|function_calls)[\s>=]/i;

function rejectSwallowedMarkup(fields: Record<string, string | undefined | null>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    if (TOOLCALL_MARKUP.test(value) || value.includes(`</${name}>`)) {
      throw new RoadmapError(
        `The "${name}" text contains tool-call parameter markup — the signature of a mis-serialized call, where every field after the break is swallowed into this one and silently lost. Nothing was stored. Re-send the write with each field as its own parameter. If you are deliberately quoting such markup, break the tag (e.g. "< parameter").`,
      );
    }
  }
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    // Write transactions read before they write (minting an id, loading a
    // project), so every one below runs .immediate() — a deferred begin would
    // hit an instant SQLITE_BUSY on the lock upgrade instead of waiting
    // (Helmo's H-134; same engine, same trap).
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- reads ----------

  getProject(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new RoadmapError(`Project "${id}" not found. IDs look like "R-4"; use roadmap_list_projects to find the one you mean.`);
    }
    return row as unknown as Project;
  }

  getDeps(id: string): { outgoing: Dep[]; incoming: Dep[] } {
    return {
      outgoing: this.db.prepare('SELECT * FROM deps WHERE from_id = ?').all(id) as Dep[],
      incoming: this.db.prepare('SELECT * FROM deps WHERE to_id = ?').all(id) as Dep[],
    };
  }

  getEvents(subjectId: string): RoadmapEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE subject_id = ? ORDER BY seq').all(subjectId) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  getClaims(projectId: string): Claim[] {
    return this.db.prepare('SELECT kind, level, size, predicted_usd, reason, author, ts FROM claims WHERE project_id = ? ORDER BY ts').all(projectId) as Claim[];
  }

  /** The latest claim of a kind is the one ranking uses; history stays. */
  latestClaim(projectId: string, kind: 'value' | 'effort'): Claim | null {
    const row = this.db
      .prepare('SELECT kind, level, size, predicted_usd, reason, author, ts FROM claims WHERE project_id = ? AND kind = ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(projectId, kind) as Claim | undefined;
    return row ?? null;
  }

  getCitations(projectId: string): Citation[] {
    return this.db.prepare('SELECT objective_id, claim FROM citations WHERE project_id = ? ORDER BY objective_id').all(projectId) as Citation[];
  }

  listObjectives(): Objective[] {
    return this.db.prepare('SELECT * FROM objectives ORDER BY rank, id').all() as Objective[];
  }

  listBets(): Bet[] {
    return this.db.prepare('SELECT * FROM bets ORDER BY id').all() as Bet[];
  }

  /** Blocked is computed from dependencies, never remembered. A blocker
   *  releases its hold by reaching a terminal status. */
  blockedBy(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT d.to_id FROM deps d JOIN projects p ON p.id = d.to_id
           WHERE d.from_id = ? AND d.type = 'blocks' AND p.status NOT IN ('shipped','abandoned')`,
        )
        .all(id) as { to_id: string }[]
    ).map((r) => r.to_id);
  }

  shipNext(): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE status = 'ship_next'").get() as Record<string, unknown> | undefined;
    return (row as unknown as Project) ?? null;
  }

  /** The derived order (PRODUCT.md): facts the store knows set the tier —
   *  ship_next, in motion, ready, shaping, blocked, parked — and judgments
   *  order within it. Rank is never set by hand, and every position carries
   *  its one-line explanation. Terminal projects are not ranked. */
  rankProjects(): Ranked[] {
    const rows = this.db
      .prepare("SELECT * FROM projects WHERE status NOT IN ('shipped','abandoned')")
      .all() as unknown as Project[];

    const entries = rows.map((p) => {
      const blocked = this.blockedBy(p.id);
      const citations = this.getCitations(p.id);
      const value = this.latestClaim(p.id, 'value');
      const effort = this.latestClaim(p.id, 'effort');
      // Parked outranks blocked-ness: parking is the human's own statement of
      // inactivity, and a blocker must not float a parked project above the
      // unblocked prerequisite it waits on (H-441).
      const tier =
        p.status === 'ship_next' ? 0 :
        p.status === 'shipping' ? 1 :
        p.status === 'parked' ? 5 :
        blocked.length ? 4 :
        p.status === 'ready' ? 2 :
        p.status === 'shaping' ? 3 : 5;
      // Project rank inherits from objective rank: the human orders a dozen
      // objectives once; the best-ranked citation carries that hand down here.
      const objRanks = citations
        .map((c) => (this.db.prepare('SELECT rank FROM objectives WHERE id = ?').get(c.objective_id) as { rank: number } | undefined)?.rank)
        .filter((r): r is number => r !== undefined);
      const bestObj = objRanks.length ? Math.min(...objRanks) : Infinity;
      const valueOrd = value?.level ? VALUE_LEVELS.indexOf(value.level) : VALUE_LEVELS.length; // unassessed sorts last in tier
      const effortOrd = effort?.size ? EFFORT_SIZES.indexOf(effort.size) : EFFORT_SIZES.length;
      return { p, blocked, citations, value, effort, tier, bestObj, valueOrd, effortOrd };
    });

    // Within a tier the actionable prerequisite comes first: a human working
    // the list top-down should never hit projects they cannot start before
    // the one they can (H-441).
    entries.sort((a, b) =>
      a.tier - b.tier ||
      Number(a.blocked.length > 0) - Number(b.blocked.length > 0) ||
      a.bestObj - b.bestObj ||
      a.valueOrd - b.valueOrd ||
      a.effortOrd - b.effortOrd ||
      a.p.created_at.localeCompare(b.p.created_at),
    );

    return entries.map((e, i) => {
      const tierWord =
        e.p.status === 'ship_next' ? 'SHIP NEXT' :
        e.p.status === 'shipping' ? 'shipping' :
        e.blocked.length ? `${e.p.status}, waits on ${e.blocked.join(', ')}` :
        e.p.status === 'ready' ? 'ready, no blockers' : e.p.status;
      const parts = [tierWord];
      const topCite = e.citations.length
        ? e.citations.reduce((best, c) => {
            const r = (this.db.prepare('SELECT rank FROM objectives WHERE id = ?').get(c.objective_id) as { rank: number } | undefined)?.rank ?? Infinity;
            return r < best.rank ? { id: c.objective_id, rank: r } : best;
          }, { id: e.citations[0]!.objective_id, rank: Infinity })
        : null;
      if (topCite) parts.push(`advances ${topCite.id}`);
      else if (this.listObjectives().length) parts.push('advances nothing stated');
      if (e.value) parts.push(`value ${e.value.level} (${e.value.author}, ${e.value.ts.slice(5, 10)})`);
      if (e.effort) parts.push(`effort ${e.effort.size}${e.effort.predicted_usd ? ` ~$${e.effort.predicted_usd}` : ''}`);
      return {
        project: e.p,
        rank: i + 1,
        explanation: `${ordinal(i + 1)} — ${parts.join(', ')}`,
        blocked_by: e.blocked,
        citations: e.citations,
        value: e.value,
        effort: e.effort,
      };
    });
  }

  // ---------- writes (every write = append event + materialize, atomically) ----------

  createProject(actor: Actor, input: CreateInput): Project {
    validateActor(actor);
    if (!input.title?.trim()) throw new RoadmapError('title is required — it is the only thing that is. A sentence of body helps the first sweep assess fit.');
    rejectSwallowedMarkup({ title: input.title, body: input.body });
    return this.db.transaction(() => {
      const id = this.mintId('R');
      const ts = now();
      const payload: Record<string, unknown> = { id, title: input.title, body: input.body ?? '', status: input.status ?? 'parked' };
      this.append(ts, id, 'created', actor, payload);
      this.applyCreated(ts, payload);
      return this.getProject(id);
    }).immediate();
  }

  updateProject(actor: Actor, input: UpdateInput): UpdateResult {
    validateActor(actor);
    if (!input.note?.trim()) {
      throw new RoadmapError('note is required on every update: one or two lines, human terms, saying what changed and why. Notes are the story the human reads.');
    }
    rejectSwallowedMarkup({ note: input.note, title: input.title, body: input.body, parked_reason: input.parked_reason, unpark_condition: input.unpark_condition });
    const p = this.getProject(input.project_id);
    const warnings: string[] = [];
    const diffs: Record<string, { from: unknown; to: unknown }> = {};

    if (TERMINAL.includes(p.status)) {
      throw new RoadmapError(`${p.id} is ${p.status} — terminal. The record is permanent; a revived idea is a new project with a 'relates' link.`);
    }

    if (input.status && input.status !== p.status) {
      if ((input.status as string) === 'ship_next') {
        throw new RoadmapError('ship_next is the human\'s call, recorded with attribution via roadmap_set_ship_next — never a plain status write.');
      }
      // Ready is a handoff test, gated by a second pair of eyes: the actor
      // declaring it must not be the last one who shaped the description.
      if (input.status === 'ready' && actor.kind === 'agent') {
        const shaper = this.lastShaper(p.id);
        if (shaper === actor.name) {
          throw new RoadmapError(
            `${p.id} was last shaped by you — the ready test ("a builder could break this into tickets without asking the human anything") needs an agent other than the shaper to read it and assert it passes. Leave it shaping; another agent or the human can declare it ready.`,
          );
        }
      }
      if (input.status === 'parked' && !input.unpark_condition && !p.unpark_condition) {
        warnings.push('parked with no unpark_condition — a parked project should record what would unpark it, or the idea rots silently instead of being retested.');
      }
      diffs['status'] = { from: p.status, to: input.status };
    }

    for (const field of ['title', 'body', 'parked_reason', 'unpark_condition'] as const) {
      const v = input[field];
      if (v !== undefined && v !== (p as unknown as Record<string, unknown>)[field]) {
        diffs[field] = { from: (p as unknown as Record<string, unknown>)[field], to: v };
      }
    }

    return this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { diffs, note: input.note };
      this.append(ts, p.id, 'updated', actor, payload);
      this.applyUpdated(ts, p.id, payload);
      return { project: this.getProject(p.id), warnings };
    }).immediate();
  }

  /** The actor who last wrote this project's title or body — the shaper the
   *  ready gate must exclude. */
  private lastShaper(id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(actor, '$.name') AS name FROM events
         WHERE subject_id = ? AND (event_type = 'created'
           OR (event_type = 'updated' AND (json_extract(payload, '$.diffs.body') IS NOT NULL OR json_extract(payload, '$.diffs.title') IS NOT NULL)))
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { name: string | null } | undefined;
    return row?.name ?? null;
  }

  recordClaim(
    actor: Actor,
    input: { project_id: string; kind: 'value' | 'effort'; level?: string; size?: string; predicted_usd?: number; reason: string },
  ): Claim {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (TERMINAL.includes(p.status)) throw new RoadmapError(`${p.id} is ${p.status} — terminal projects take no new judgments.`);
    if (!input.reason?.trim()) {
      throw new RoadmapError('reason is required — a judgment without its one-line why is a naked number, and naked numbers decay into decoration.');
    }
    if (input.kind === 'value' && !VALUE_LEVELS.includes(input.level as never)) {
      throw new RoadmapError(`value claims need level: ${VALUE_LEVELS.join('|')}.`);
    }
    if (input.kind === 'effort' && !EFFORT_SIZES.includes(input.size as never)) {
      throw new RoadmapError(`effort claims need size: ${EFFORT_SIZES.join('|')} (predicted_usd optional but is what makes the estimate falsifiable against the metered actual).`);
    }
    rejectSwallowedMarkup({ reason: input.reason });
    return this.db.transaction(() => {
      const ts = now();
      const payload: Record<string, unknown> = { kind: input.kind, reason: input.reason };
      if (input.kind === 'value') payload['level'] = input.level;
      if (input.kind === 'effort') { payload['size'] = input.size; if (input.predicted_usd !== undefined) payload['predicted_usd'] = input.predicted_usd; }
      this.append(ts, p.id, 'claim_recorded', actor, payload);
      this.applyClaim(ts, p.id, actor, payload);
      return this.latestClaim(p.id, input.kind)!;
    }).immediate();
  }

  cite(actor: Actor, input: { project_id: string; objective_id: string; claim?: string; action?: 'add' | 'remove' }): Citation[] {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    const action = input.action ?? 'add';
    if (action === 'add') {
      if (!this.db.prepare('SELECT 1 FROM objectives WHERE id = ?').get(input.objective_id)) {
        throw new RoadmapError(`Objective "${input.objective_id}" is not in the charter projection. Objectives: ${this.listObjectives().map((o) => o.id).join(', ') || '(none derived yet)'}.`);
      }
      if (!input.claim?.trim()) {
        throw new RoadmapError('claim is required: one line on HOW this project advances the objective — that is what makes the citation checkable and lets the human disagree with the mapping instead of a number.');
      }
    }
    rejectSwallowedMarkup({ claim: input.claim });
    this.db.transaction(() => {
      const ts = now();
      if (action === 'add') {
        this.append(ts, p.id, 'cited', actor, { objective_id: input.objective_id, claim: input.claim });
        this.applyCited(p.id, { objective_id: input.objective_id, claim: input.claim }, true);
      } else {
        this.append(ts, p.id, 'uncited', actor, { objective_id: input.objective_id });
        this.applyCited(p.id, { objective_id: input.objective_id }, false);
      }
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, p.id);
    }).immediate();
    return this.getCitations(p.id);
  }

  link(actor: Actor, fromId: string, toId: string, type: DepType, action: 'add' | 'remove'): void {
    validateActor(actor);
    this.getProject(fromId);
    this.getProject(toId);
    if (fromId === toId) throw new RoadmapError('A project cannot link to itself.');
    this.db.transaction(() => {
      const ts = now();
      if (action === 'add') {
        this.checkNoBlocksCycle(fromId, toId, type);
        this.append(ts, fromId, 'linked', actor, { to: toId, type });
        this.applyLinked(fromId, toId, type, true);
      } else {
        this.append(ts, fromId, 'unlinked', actor, { to: toId, type });
        this.applyLinked(fromId, toId, type, false);
      }
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, fromId);
    }).immediate();
  }

  /** Exactly one ship_next, and it is the human's decision — an agent only
   *  records it, with attribution, the way Helmo's answer route works. Any
   *  current holder steps back to ready in the same event. */
  setShipNext(actor: Actor, input: { project_id: string; decided_by: string; reason: string }): Project {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (!input.decided_by?.trim()) throw new RoadmapError('decided_by is required: the human who made the call. Ship-next is never an agent\'s own judgment.');
    if (!input.reason?.trim()) throw new RoadmapError('reason is required: the human\'s one-line why, so the fleet reads a decision, not a flag.');
    if (p.status !== 'ready') {
      throw new RoadmapError(`${p.id} is ${p.status} — only a ready project can be declared ship_next. The ready gate is what makes "go" mean a builder can start.`);
    }
    rejectSwallowedMarkup({ reason: input.reason });
    return this.db.transaction(() => {
      const ts = now();
      const current = this.shipNext();
      const payload: Record<string, unknown> = { decided_by: input.decided_by, reason: input.reason, demoted: current?.id ?? null };
      this.append(ts, p.id, 'ship_next_set', actor, payload);
      this.applyShipNext(ts, p.id, payload);
      return this.getProject(p.id);
    }).immediate();
  }

  /** Progress and cost are read back from Helmo's metered tickets by the
   *  sweep, never self-reported — this records that rollup. Absolute, not a
   *  delta: the rollup is recomputed each sweep. */
  recordActual(actor: Actor, input: { project_id: string; actual_usd: number; note: string }): Project {
    validateActor(actor);
    const p = this.getProject(input.project_id);
    if (!(input.actual_usd >= 0)) throw new RoadmapError('actual_usd must be a non-negative number — it is the metered total to date.');
    if (!input.note?.trim()) throw new RoadmapError('note is required: say where the rollup came from (e.g. which Helmo project tag, how many tickets).');
    rejectSwallowedMarkup({ note: input.note });
    return this.db.transaction(() => {
      const ts = now();
      const payload = { actual_usd: input.actual_usd, note: input.note };
      this.append(ts, p.id, 'actual_recorded', actor, payload);
      this.applyActual(p.id, payload);
      return this.getProject(p.id);
    }).immediate();
  }

  /** Upsert one charter projection item. The charter itself lives wherever
   *  its author keeps it; this records the derived projection, with `source`
   *  pointing home so drift is visible rather than silent. */
  setCharterItem(
    actor: Actor,
    input: {
      shape: 'objective' | 'bet';
      id?: string;
      statement: string;
      source: string;
      horizon?: Horizon; // objectives
      rank?: number; // objectives
      stake?: string; // bets
      falsifier?: string; // bets
    },
  ): Objective | Bet {
    validateActor(actor);
    if (!input.statement?.trim()) throw new RoadmapError('statement is required: the short quotable line a citation will point at.');
    if (!input.source?.trim()) throw new RoadmapError('source is required: the pointer back to the authoritative document this was derived from.');
    if (input.shape === 'objective') {
      if (!input.horizon) throw new RoadmapError('objectives need horizon: near|long|standing.');
      if (!(typeof input.rank === 'number' && input.rank >= 1)) {
        throw new RoadmapError('objectives need rank (1 = top): the human\'s ordering of the few durable things is what project rank inherits from.');
      }
    } else if (!input.stake?.trim() || !input.falsifier?.trim()) {
      throw new RoadmapError('bets need stake (what rides on this being true) and falsifier (what would show it false).');
    }
    rejectSwallowedMarkup({ statement: input.statement, stake: input.stake, falsifier: input.falsifier });
    return this.db.transaction(() => {
      const ts = now();
      const id = input.id ?? this.mintId(input.shape === 'objective' ? 'OBJ' : 'BET');
      if (input.id && input.shape === 'objective' && !input.id.startsWith('OBJ-')) throw new RoadmapError(`"${input.id}" is not an objective id (OBJ-n).`);
      if (input.id && input.shape === 'bet' && !input.id.startsWith('BET-')) throw new RoadmapError(`"${input.id}" is not a bet id (BET-n).`);
      const payload: Record<string, unknown> =
        input.shape === 'objective'
          ? { id, statement: input.statement, horizon: input.horizon, rank: input.rank, source: input.source }
          : { id, statement: input.statement, stake: input.stake, falsifier: input.falsifier, source: input.source };
      this.append(ts, id, input.shape === 'objective' ? 'objective_set' : 'bet_set', actor, payload);
      this.applyCharterItem(ts, input.shape, payload);
      const table = input.shape === 'objective' ? 'objectives' : 'bets';
      return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Objective | Bet;
    }).immediate();
  }

  // ---------- rebuild (the invariant) ----------

  /** Reconstruct all materialized state purely from the event log. Tests
   *  enforce that this always reproduces what the writes built. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM projects; DELETE FROM deps; DELETE FROM claims; DELETE FROM citations; DELETE FROM objectives; DELETE FROM bets;');
      const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, unknown>[];
      for (const row of rows) {
        const ev = rowToEvent(row);
        switch (ev.event_type) {
          case 'created': this.applyCreated(ev.ts, ev.payload); break;
          case 'updated': this.applyUpdated(ev.ts, ev.subject_id, ev.payload); break;
          case 'claim_recorded': this.applyClaim(ev.ts, ev.subject_id, ev.actor, ev.payload); break;
          case 'cited': this.applyCited(ev.subject_id, ev.payload, true); break;
          case 'uncited': this.applyCited(ev.subject_id, ev.payload, false); break;
          case 'linked': this.applyLinked(ev.subject_id, ev.payload['to'] as string, ev.payload['type'] as DepType, true); break;
          case 'unlinked': this.applyLinked(ev.subject_id, ev.payload['to'] as string, ev.payload['type'] as DepType, false); break;
          case 'ship_next_set': this.applyShipNext(ev.ts, ev.subject_id, ev.payload); break;
          case 'actual_recorded': this.applyActual(ev.subject_id, ev.payload); break;
          case 'objective_set': this.applyCharterItem(ev.ts, 'objective', ev.payload); break;
          case 'bet_set': this.applyCharterItem(ev.ts, 'bet', ev.payload); break;
        }
      }
    }).immediate();
  }

  dumpState(): Record<string, unknown[]> {
    const all = (t: string) => this.db.prepare(`SELECT * FROM ${t}`).all() as unknown[];
    return {
      projects: all('projects ORDER BY id'),
      deps: all('deps ORDER BY from_id, to_id, type'),
      claims: all('claims ORDER BY project_id, ts, rowid'),
      citations: all('citations ORDER BY project_id, objective_id'),
      objectives: all('objectives ORDER BY id'),
      bets: all('bets ORDER BY id'),
    };
  }

  // ---------- internals ----------

  private mintId(prefix: string): string {
    const key = `next_${prefix}`;
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    const n = row ? parseInt(row.value, 10) : 1;
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(n + 1));
    return `${prefix}-${n}`;
  }

  private append(ts: string, subjectId: string, type: string, actor: Actor, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO events (ts, subject_id, event_type, actor, payload) VALUES (?, ?, ?, ?, ?)')
      .run(ts, subjectId, type, JSON.stringify(actor), JSON.stringify(payload));
  }

  private applyCreated(ts: string, p: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO projects (id, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p['id'], p['title'], p['body'] ?? '', p['status'] ?? 'parked', ts, ts);
  }

  private applyUpdated(ts: string, id: string, payload: Record<string, unknown>): void {
    const diffs = (payload['diffs'] ?? {}) as Record<string, { from: unknown; to: unknown }>;
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [ts];
    for (const [field, d] of Object.entries(diffs)) {
      if (!['title', 'body', 'status', 'parked_reason', 'unpark_condition'].includes(field)) continue;
      sets.push(`${field} = ?`);
      params.push(d.to as never);
    }
    const status = diffs['status']?.to as Status | undefined;
    if (status && TERMINAL.includes(status)) { sets.push('closed_at = ?'); params.push(ts); }
    params.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private applyClaim(ts: string, id: string, actor: Actor, p: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO claims (project_id, kind, level, size, predicted_usd, reason, author, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p['kind'], p['level'] ?? null, p['size'] ?? null, p['predicted_usd'] ?? null, p['reason'], actor.name, ts);
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(ts, id);
  }

  private applyCited(id: string, p: Record<string, unknown>, add: boolean): void {
    if (add) {
      this.db
        .prepare('INSERT INTO citations (project_id, objective_id, claim) VALUES (?, ?, ?) ON CONFLICT(project_id, objective_id) DO UPDATE SET claim = excluded.claim')
        .run(id, p['objective_id'], p['claim']);
    } else {
      this.db.prepare('DELETE FROM citations WHERE project_id = ? AND objective_id = ?').run(id, p['objective_id']);
    }
  }

  private applyLinked(fromId: string, toId: string, type: DepType, add: boolean): void {
    if (add) {
      this.db.prepare('INSERT OR IGNORE INTO deps (from_id, to_id, type) VALUES (?, ?, ?)').run(fromId, toId, type);
    } else {
      this.db.prepare('DELETE FROM deps WHERE from_id = ? AND to_id = ? AND type = ?').run(fromId, toId, type);
    }
  }

  private applyShipNext(ts: string, id: string, payload: Record<string, unknown>): void {
    const demoted = payload['demoted'] as string | null;
    if (demoted) this.db.prepare("UPDATE projects SET status = 'ready', updated_at = ? WHERE id = ?").run(ts, demoted);
    this.db.prepare("UPDATE projects SET status = 'ship_next', updated_at = ? WHERE id = ?").run(ts, id);
  }

  private applyActual(id: string, payload: Record<string, unknown>): void {
    this.db.prepare('UPDATE projects SET actual_usd = ? WHERE id = ?').run(payload['actual_usd'], id);
  }

  private applyCharterItem(ts: string, shape: 'objective' | 'bet', p: Record<string, unknown>): void {
    if (shape === 'objective') {
      this.db
        .prepare(
          `INSERT INTO objectives (id, statement, horizon, rank, source, derived_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, horizon = excluded.horizon,
             rank = excluded.rank, source = excluded.source, derived_at = excluded.derived_at`,
        )
        .run(p['id'], p['statement'], p['horizon'], p['rank'], p['source'], ts);
    } else {
      this.db
        .prepare(
          `INSERT INTO bets (id, statement, stake, falsifier, source, derived_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, stake = excluded.stake,
             falsifier = excluded.falsifier, source = excluded.source, derived_at = excluded.derived_at`,
        )
        .run(p['id'], p['statement'], p['stake'], p['falsifier'], p['source'], ts);
    }
  }

  private checkNoBlocksCycle(fromId: string, toId: string, type: DepType): void {
    if (type !== 'blocks') return;
    const seen = new Set<string>();
    const stack = [toId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === fromId) {
        throw new RoadmapError(`Adding blocks ${fromId} -> ${toId} would create a cycle: these projects would wait on each other forever.`);
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = this.db.prepare("SELECT to_id FROM deps WHERE from_id = ? AND type = 'blocks'").all(cur) as { to_id: string }[];
      for (const n of next) stack.push(n.to_id);
    }
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? 'th'}`;
}

function rowToEvent(row: Record<string, unknown>): RoadmapEvent {
  return {
    ...(row as unknown as RoadmapEvent),
    actor: JSON.parse(row['actor'] as string),
    payload: JSON.parse(row['payload'] as string),
  };
}
