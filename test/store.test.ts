import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const mason: Actor = { name: 'mason', kind: 'agent', model: 'claude-fable-5', version: 'test' };
const bosun: Actor = { name: 'bosun', kind: 'agent', model: 'claude-fable-5', version: 'test' };
const arthur: Actor = { name: 'arthur', kind: 'human' };

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('projects', () => {
  it('an idea costs a title and nothing else', () => {
    const p = store.createProject(mason, { title: 'Run a hackathon at the co-working space' });
    expect(p.id).toBe('R-1');
    expect(p.status).toBe('parked');
    expect(p.body).toBe('');
  });

  it('rejects an agent actor without model/version', () => {
    expect(() => store.createProject({ name: 'x', kind: 'agent' }, { title: 't' })).toThrow(/model/);
  });

  it('updates require a note and terminal projects are permanent', () => {
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: '', status: 'ready' })).toThrow(/note/);
    store.updateProject(bosun, { project_id: p.id, note: 'shipped it', status: 'shipped' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'reopen', status: 'shaping' })).toThrow(/terminal/);
  });

  it('parking without an exit warns', () => {
    const p = store.createProject(mason, { title: 'T', status: 'shaping' });
    const { warnings } = store.updateProject(mason, { project_id: p.id, note: 'not now', status: 'parked' });
    expect(warnings.some((w) => w.includes('unpark_condition'))).toBe(true);
  });
});

describe('the ready gate', () => {
  it('the shaper cannot declare their own work ready', () => {
    const p = store.createProject(mason, { title: 'T', body: 'the full plan', status: 'shaping' });
    expect(() => store.updateProject(mason, { project_id: p.id, note: 'done shaping', status: 'ready' })).toThrow(/second pair of eyes|other than the shaper|shaped by you/);
    // A different agent read it and asserts the handoff test passes.
    const { project } = store.updateProject(bosun, { project_id: p.id, note: 'read it; a builder could ticket this unaided', status: 'ready' });
    expect(project.status).toBe('ready');
  });

  it('the human is never gated', () => {
    const p = store.createProject(mason, { title: 'T', body: 'plan', status: 'shaping' });
    const { project } = store.updateProject(arthur, { project_id: p.id, note: 'good enough', status: 'ready' });
    expect(project.status).toBe('ready');
  });
});

describe('ship next', () => {
  function readyProject(title: string): string {
    const p = store.createProject(mason, { title, status: 'shaping' });
    store.updateProject(bosun, { project_id: p.id, note: 'ready', status: 'ready' });
    return p.id;
  }

  it('only a ready project, only via the recorded human decision, and exactly one', () => {
    const a = readyProject('A');
    const b = readyProject('B');
    const parked = store.createProject(mason, { title: 'C' });

    expect(() => store.updateProject(mason, { project_id: a, note: 'go', status: 'ship_next' as never })).toThrow(/ship_next/);
    expect(() => store.setShipNext(mason, { project_id: parked.id, decided_by: 'arthur', reason: 'r' })).toThrow(/ready/);
    expect(() => store.setShipNext(mason, { project_id: a, decided_by: '', reason: 'r' })).toThrow(/decided_by/);

    store.setShipNext(mason, { project_id: a, decided_by: 'arthur', reason: 'unblocks the fleet' });
    expect(store.shipNext()!.id).toBe(a);

    // Declaring B demotes A back to ready — the instant there are three,
    // it is priority 1 again in a louder font.
    store.setShipNext(mason, { project_id: b, decided_by: 'arthur', reason: 'changed his mind' });
    expect(store.shipNext()!.id).toBe(b);
    expect(store.getProject(a).status).toBe('ready');
  });
});

describe('claims, citations, ranking', () => {
  it('judgments are never naked numbers', () => {
    const p = store.createProject(mason, { title: 'T' });
    expect(() => store.recordClaim(mason, { project_id: p.id, kind: 'value', level: 'high', reason: ' ' })).toThrow(/reason/);
    expect(() => store.recordClaim(mason, { project_id: p.id, kind: 'effort', reason: 'r' })).toThrow(/size/);
    const c = store.recordClaim(mason, { project_id: p.id, kind: 'effort', size: 'L', predicted_usd: 40, reason: 'store + view + seam' });
    expect(c.author).toBe('mason');
    expect(c.predicted_usd).toBe(40);
  });

  it('citations need a real objective and a how-claim', () => {
    const p = store.createProject(mason, { title: 'T' });
    expect(() => store.cite(mason, { project_id: p.id, objective_id: 'OBJ-9', claim: 'x' })).toThrow(/not in the charter/);
    store.setCharterItem(mason, { shape: 'objective', statement: 'Ship in public', horizon: 'standing', rank: 1, source: '~/charter.md' });
    expect(() => store.cite(mason, { project_id: p.id, objective_id: 'OBJ-1' })).toThrow(/claim/);
    const cites = store.cite(mason, { project_id: p.id, objective_id: 'OBJ-1', claim: 'because it ships publicly alongside Helmo' });
    expect(cites).toHaveLength(1);
  });

  it('rank derives from facts first, judgments within tier, and explains itself', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O1', horizon: 'near', rank: 1, source: 's' });
    const ready = store.createProject(mason, { title: 'ready-high', status: 'shaping' });
    store.updateProject(bosun, { project_id: ready.id, note: 'ok', status: 'ready' });
    const readyLow = store.createProject(mason, { title: 'ready-low', status: 'shaping' });
    store.updateProject(bosun, { project_id: readyLow.id, note: 'ok', status: 'ready' });
    const shaping = store.createProject(mason, { title: 'shaping', status: 'shaping' });
    const parked = store.createProject(mason, { title: 'parked' });

    store.recordClaim(mason, { project_id: ready.id, kind: 'value', level: 'high', reason: 'r' });
    store.recordClaim(mason, { project_id: readyLow.id, kind: 'value', level: 'low', reason: 'r' });
    store.cite(mason, { project_id: ready.id, objective_id: 'OBJ-1', claim: 'directly' });

    const order = store.rankProjects().map((r) => r.project.title);
    expect(order).toEqual(['ready-high', 'ready-low', 'shaping', 'parked']);

    const top = store.rankProjects()[0]!;
    expect(top.explanation).toContain('1st');
    expect(top.explanation).toContain('ready, no blockers');
    expect(top.explanation).toContain('advances OBJ-1');
    expect(top.explanation).toContain('value high (mason');
  });

  it('a blocked project sinks below shaping and the blocker releases by shipping', () => {
    const a = store.createProject(mason, { title: 'A', status: 'shaping' });
    store.updateProject(bosun, { project_id: a.id, note: 'ok', status: 'ready' });
    const b = store.createProject(mason, { title: 'B', status: 'shaping' });
    store.link(mason, a.id, b.id, 'blocks', 'add');

    expect(store.blockedBy(a.id)).toEqual([b.id]);
    const order = store.rankProjects().map((r) => r.project.title);
    expect(order).toEqual(['B', 'A']); // shaping B outranks blocked-ready A

    store.updateProject(bosun, { project_id: b.id, note: 'done', status: 'shipped' });
    expect(store.blockedBy(a.id)).toEqual([]);
  });

  it('a blocked project never floats above the unblocked prerequisite it waits on (H-441)', () => {
    // The 2026-08-27 board shape: keystone R-12 parked and unblocked; R-13,
    // R-14 parked and waiting on it; R-15 parked and waiting on R-14. The old
    // tiering put blocked (4) above parked (5), ranking the keystone last.
    const keystone = store.createProject(mason, { title: 'keystone' });
    const waiter1 = store.createProject(mason, { title: 'waiter1' });
    const waiter2 = store.createProject(mason, { title: 'waiter2' });
    const chained = store.createProject(mason, { title: 'chained' });
    store.link(mason, waiter1.id, keystone.id, 'blocks', 'add');
    store.link(mason, waiter2.id, keystone.id, 'blocks', 'add');
    store.link(mason, chained.id, waiter2.id, 'blocks', 'add');
    store.recordClaim(mason, { project_id: keystone.id, kind: 'value', level: 'high', reason: 'r' });
    store.recordClaim(mason, { project_id: waiter1.id, kind: 'value', level: 'high', reason: 'r' });

    const order = store.rankProjects().map((r) => r.project.title);
    expect(order[0]).toBe('keystone');
    expect(order.indexOf('keystone')).toBeLessThan(order.indexOf('waiter1'));
    expect(order.indexOf('keystone')).toBeLessThan(order.indexOf('waiter2'));
  });

  it('blocks cycles are refused', () => {
    const a = store.createProject(mason, { title: 'A' });
    const b = store.createProject(mason, { title: 'B' });
    store.link(mason, a.id, b.id, 'blocks', 'add');
    expect(() => store.link(mason, b.id, a.id, 'blocks', 'add')).toThrow(/cycle/);
  });
});

describe('charter projection and actuals', () => {
  it('objectives and bets upsert by id with drift-visible provenance', () => {
    const o = store.setCharterItem(mason, { shape: 'objective', statement: 'v1', horizon: 'near', rank: 2, source: 'doc' });
    const o2 = store.setCharterItem(mason, { shape: 'objective', id: o.id, statement: 'v2', horizon: 'near', rank: 1, source: 'doc' });
    expect(o2.id).toBe(o.id);
    expect(store.listObjectives()).toHaveLength(1);
    expect(store.listObjectives()[0]!.statement).toBe('v2');

    const bet = store.setCharterItem(mason, { shape: 'bet', statement: 'agents can shape well', stake: 'the shaping loop', falsifier: 'ready projects bounce off builders', source: 'doc' });
    expect(bet.id).toBe('BET-1');
    expect(() => store.setCharterItem(mason, { shape: 'bet', statement: 's', source: 'doc' })).toThrow(/stake/);
  });

  it('actuals are absolute rollups', () => {
    const p = store.createProject(mason, { title: 'T' });
    store.recordActual(bosun, { project_id: p.id, actual_usd: 12.5, note: '3 tickets tagged r-1' });
    store.recordActual(bosun, { project_id: p.id, actual_usd: 20, note: '5 tickets tagged r-1' });
    expect(store.getProject(p.id).actual_usd).toBe(20);
  });
});

describe('the invariant', () => {
  it('rebuild from the event log reproduces the materialized state exactly', () => {
    store.setCharterItem(mason, { shape: 'objective', statement: 'O', horizon: 'long', rank: 1, source: 's' });
    const a = store.createProject(mason, { title: 'A', body: 'plan', status: 'shaping' });
    const b = store.createProject(mason, { title: 'B' });
    store.updateProject(bosun, { project_id: a.id, note: 'ok', status: 'ready' });
    store.recordClaim(mason, { project_id: a.id, kind: 'value', level: 'high', reason: 'r' });
    store.recordClaim(mason, { project_id: a.id, kind: 'effort', size: 'M', predicted_usd: 15, reason: 'r' });
    store.cite(mason, { project_id: a.id, objective_id: 'OBJ-1', claim: 'how' });
    store.link(mason, b.id, a.id, 'relates', 'add');
    store.setShipNext(mason, { project_id: a.id, decided_by: 'arthur', reason: 'go' });
    store.recordActual(bosun, { project_id: a.id, actual_usd: 3, note: '1 ticket' });
    store.updateProject(mason, { project_id: b.id, note: 'park it', status: 'parked', unpark_condition: 'when A ships' });

    const before = JSON.stringify(store.dumpState());
    store.rebuild();
    expect(JSON.stringify(store.dumpState())).toBe(before);
  });

  it('swallowed tool-call markup is rejected at the door', () => {
    expect(() => store.createProject(mason, { title: 'x </title> <parameter name="body">oops' })).toThrow(/markup/);
  });
});
