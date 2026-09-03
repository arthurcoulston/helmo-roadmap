#!/usr/bin/env node
// The roadmap view: agent-written, human-read, and — unlike Helmo's dashboard,
// which carries the one answer route — fully read-only. Ship-next at the top,
// expanded; everything below it collapsed, in derived rank order. One file,
// zero dependencies, no build step beyond tsc.
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ESTATE_TOKENS } from './estate-tokens.generated.js';
import { Store } from './store.js';
import { Claim, Project, Ranked, RoadmapEvent } from './types.js';

const dbPath = process.env['ROADMAP_DB'] ?? join(homedir(), '.helmo-roadmap', 'roadmap.db');
// The view may be the first thing to touch a fresh store — don't crash on a
// missing home directory (caught by launchd on first boot).
mkdirSync(join(dbPath, '..'), { recursive: true });
const port = Number(process.env['ROADMAP_VIEW_PORT'] ?? 4410);
const host = process.env['ROADMAP_VIEW_HOST'] ?? '127.0.0.1';
const store = new Store(dbPath);

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d ago` : new Date(iso).toISOString().slice(0, 10);
}

function claimLine(c: Claim | null): string {
  if (!c) return '';
  const what = c.kind === 'value' ? `value ${c.level}` : `effort ${c.size}${c.predicted_usd ? ` ~$${c.predicted_usd}` : ''}`;
  return `<span class="claim"><b>${esc(what)}</b> — ${esc(c.reason)} <span class="attr">(${esc(c.author)}, ${esc(rel(c.ts))})</span></span>`;
}

function money(p: Project, effort: Claim | null): string {
  const pred = effort?.predicted_usd;
  if (!p.actual_usd && !pred) return '';
  const parts = [];
  if (pred) parts.push(`$${pred} predicted`);
  if (p.actual_usd) parts.push(`$${p.actual_usd.toFixed(2)} metered`);
  return `<span class="spend">${parts.join(' · ')}</span>`;
}

function timeline(events: RoadmapEvent[]): string {
  const items = events.map((e) => {
    const note = (e.payload['note'] as string) ?? (e.payload['reason'] as string) ?? (e.payload['claim'] as string) ?? '';
    const what =
      e.event_type === 'created' ? 'filed' :
      e.event_type === 'ship_next_set' ? `SHIP NEXT — decided by ${esc(e.payload['decided_by'])}` :
      e.event_type === 'claim_recorded' ? `${e.payload['kind']} claim` :
      e.event_type === 'cited' ? `cited ${esc(e.payload['objective_id'])}` :
      e.event_type === 'actual_recorded' ? `metered $${e.payload['actual_usd']}` :
      e.event_type === 'updated' ? statusMove(e) : '';
    return `<div class="tl"><span class="tl-when">${esc(rel(e.ts))}</span><span class="tl-who">${esc(e.actor.name)}</span>${
      what ? `<span class="tl-what">${what}</span>` : ''
    }${note ? `<span class="tl-note">${esc(note)}</span>` : ''}</div>`;
  });
  return items.length ? `<div class="tl-wrap">${items.join('')}</div>` : '';
}

function statusMove(e: RoadmapEvent): string {
  const d = (e.payload['diffs'] as Record<string, { from: unknown; to: unknown }> | undefined)?.['status'];
  return d ? `${esc(d.from)} → ${esc(d.to)}` : '';
}

function details(r: Ranked): string {
  const deps = store.getDeps(r.project.id);
  const related = [...deps.outgoing.filter((d) => d.type === 'relates').map((d) => d.to_id), ...deps.incoming.filter((d) => d.type === 'relates').map((d) => d.from_id)];
  return `${r.project.body ? `<div class="body">${esc(r.project.body)}</div>` : ''}
  ${r.project.status === 'parked' && (r.project.parked_reason || r.project.unpark_condition)
    ? `<div class="park">${r.project.parked_reason ? `parked: ${esc(r.project.parked_reason)}` : ''}${r.project.unpark_condition ? ` <b>unparks when:</b> ${esc(r.project.unpark_condition)}` : ''}</div>`
    : ''}
  ${r.citations.map((c) => `<div class="cite"><span class="oid">${esc(c.objective_id)}</span> ${esc(c.claim)}</div>`).join('')}
  ${claimLine(r.value)}${claimLine(r.effort)}
  ${r.blocked_by.length ? `<div class="park">⛔ waits on ${esc(r.blocked_by.join(', '))}</div>` : ''}
  ${related.length ? `<div class="park">related: ${esc(related.join(', '))}</div>` : ''}
  ${timeline(store.getEvents(r.project.id))}`;
}

// The hero cards: the work phase — everything the human has declared go on.
function shipNextCard(r: Ranked): string {
  const decision = [...store.getEvents(r.project.id)].reverse().find((e) => e.event_type === 'ship_next_set');
  return `<article class="hero-card" id="${esc(r.project.id)}">
    <header><span class="pid">${esc(r.project.id)}</span> <span class="htitle">${esc(r.project.title)}</span>
      <span class="meta">${money(r.project, r.effort)} · ${esc(rel(r.project.updated_at))}</span></header>
    ${decision ? `<p class="decision"><span class="dmark">ship next</span> decided by <b>${esc(decision.payload['decided_by'])}</b>, ${esc(rel(decision.ts))} — ${esc(decision.payload['reason'])}</p>` : ''}
    ${r.project.body ? `<div class="body">${esc(r.project.body)}</div>` : ''}
    ${r.citations.map((c) => `<div class="cite"><span class="oid">${esc(c.objective_id)}</span> ${esc(c.claim)}</div>`).join('')}
    ${claimLine(r.value)}${claimLine(r.effort)}
    <details class="more" id="d-${esc(r.project.id)}"><summary>history</summary>${timeline(store.getEvents(r.project.id))}</details>
  </article>`;
}

function row(r: Ranked): string {
  const p = r.project;
  const noCite = !r.citations.length && store.listObjectives().length > 0;
  return `<details class="prow" id="${esc(p.id)}">
    <summary>
      <span class="rank">${r.rank}</span>
      <span class="pid">${esc(p.id)}</span>
      <span class="rtitle">${esc(p.title)}</span>
      <span class="badge quiet">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
      ${r.blocked_by.length ? `<span class="badge serious">⛔ waits on ${esc(r.blocked_by.join(', '))}</span>` : ''}
      ${noCite ? '<span class="badge quiet">∅ advances nothing stated</span>' : ''}
      <span class="rmeta">${money(p, r.effort)} · ${esc(rel(p.updated_at))}</span>
      <span class="explain">${esc(r.explanation)}</span>
    </summary>
    ${details(r)}
  </details>`;
}

const STATUS_LABEL: Record<string, string> = {
  ship_next: 'ship next',
  shipped_watching: 'watching',
  shipped_stable: 'stable',
};

// Off-list rows: shipped (watching/stable) and archived projects carry no
// rank — the body and the trail are what a reader comes for.
function shelfRow(p: Project): string {
  return `<details class="prow" id="${esc(p.id)}">
    <summary><span class="pid">${esc(p.id)}</span><span class="rtitle">${esc(p.title)}</span>
      <span class="badge quiet">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
      <span class="rmeta">${p.actual_usd ? `$${p.actual_usd.toFixed(2)} metered · ` : ''}${esc(rel(p.closed_at ?? p.updated_at))}</span></summary>
    ${p.body ? `<div class="body">${esc(p.body)}</div>` : ''}
    ${timeline(store.getEvents(p.id))}
  </details>`;
}

// The charter projection: the human's hand, read-only here by double measure.
function charterStrip(): string {
  const objectives = store.listObjectives();
  const bets = store.listBets();
  if (!objectives.length && !bets.length) return '';
  return `<section class="charter"><h2>Charter</h2>
    ${objectives
      .map((o) => `<p class="citem"><span class="oid">${esc(o.id)}</span><span class="crank">#${o.rank}</span>
        <span class="cstate">${esc(o.statement)}</span> <span class="attr">${esc(o.horizon)} · from ${esc(o.source)}</span></p>`)
      .join('')}
    ${bets
      .map((b) => `<p class="citem"><span class="oid">${esc(b.id)}</span>
        <span class="cstate">${esc(b.statement)}</span> <span class="attr">stake: ${esc(b.stake)} · falsified by: ${esc(b.falsifier)}</span></p>`)
      .join('')}
  </section>`;
}

function page(): string {
  const ranked = store.rankProjects();
  const shipNext = ranked.filter((r) => r.project.status === 'ship_next');
  const rest = ranked.filter((r) => r.project.status !== 'ship_next');
  const all = store.dumpState()['projects'] as Project[];
  const watching = all.filter((p) => p.status === 'shipped_watching');
  const stable = all.filter((p) => p.status === 'shipped_stable');
  const archived = all.filter((p) => p.status === 'archived');

  const stat = (n: number, label: string, alarm = false) =>
    `<div class="stat"><div class="stat-n${alarm ? ' alarm' : ''}">${n}</div><div class="stat-l">${label}</div></div>`;
  const count = (s: string) => ranked.filter((r) => r.project.status === s).length;

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roadmap</title>
<style>${CSS}</style>
<body>
<header class="top">
  <div class="brand"><h1>Roadmap</h1><span class="tagline">work worth doing · agents write, you read</span></div>
  <div class="stats">
    ${stat(shipNext.length, 'ship next', shipNext.length >= 3)}${stat(watching.length, 'watching')}${stat(count('ready'), 'ready')}${stat(count('shaping'), 'shaping')}${stat(count('parked'), 'parked')}
  </div>
</header>

<section class="hero">
  <h2>Ship next${shipNext.length ? ` (${shipNext.length})` : ''}</h2>
  ${shipNext.length >= 3 ? '<p class="alarm-note">A growing work phase is a problem — what here is close enough to move to watching?</p>' : ''}
  ${shipNext.length ? shipNext.map(shipNextCard).join('') : '<p class="allclear">Nothing has the go-ahead. The list below is ranked and waiting for your call.</p>'}
</section>

${charterStrip()}

${watching.length ? `<section><h2>Shipped — watching</h2>${watching.map(shelfRow).join('')}</section>` : ''}

<section><h2>The list</h2>
${rest.length ? rest.map(row).join('') : '<p class="allclear">Empty. Ideas cost a title and a sentence.</p>'}
</section>

${stable.length ? `<section><h2>Shipped — stable</h2>${stable.map(shelfRow).join('')}</section>` : ''}
${archived.length ? `<section><h2>Archived (${archived.length})</h2>${archived.map(shelfRow).join('')}</section>` : ''}

<footer>read-only — the record is written by agents, including your decisions · ${esc(dbPath)} · refreshed <span id="age">just now</span></footer>
<script>${JS}</script>
</body></html>`;
}

// Chrome, ink and shape come from the estate's design tokens, vendored
// (R-11 H-714): one visual system across Helmo, the roadmap, rev, the health
// page and the estate shell. The roadmap keeps its own token names and every
// rule below is unchanged — the aliases are the whole seam, so a look ratified
// upstream restyles this page without it being touched. Status colours stay the
// roadmap's own and the block below says why.
//
// ESTATE_TOKENS goes first: the aliases read from it, and it brings the dark
// values under prefers-color-scheme, which is what a page with no theme
// switch needs.
const CSS = `
${ESTATE_TOKENS}
:root {
  color-scheme: light dark;
  --page: var(--background); --surface: var(--card); --ink: var(--foreground);
  /* The roadmap runs a three-step ink ladder where shadcn has two; the middle
     step is mixed rather than picked, so a look change carries it too. */
  --ink-2: color-mix(in oklab, var(--foreground) 72%, var(--background));
  --ink-3: var(--muted-foreground);
  --hairline: var(--border);
  --radius-card: var(--radius); --radius-inner: calc(var(--radius) * 0.8);

  /* Not adopted, deliberately. shadcn's neutral base ships no status ramp, and
     its own --accent is a hover SURFACE, not an interactive colour — mapping
     onto either would be translation, not adoption. These follow the reference
     palette (dataviz skill) and always ride with a text label, never colour
     alone. Whether the estate gets a status ramp and an interactive hue of its
     own is the palette question on H-714, not this file's. */
  --good-text: #006300; --serious: #ec835a; --link: #2a78d6;
}
@media (prefers-color-scheme: dark) { :root {
  --good-text: #0ca30c; --link: #3987e5;
} }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 28px 32px 64px; max-width: 1080px; background: var(--page); color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
.brand h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; display: inline; }
.tagline { color: var(--ink-3); margin-left: 10px; font-size: 13px; }
.stats { display: flex; gap: 22px; }
.stat-n { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
.stat-n.alarm { color: var(--serious); }
.alarm-note { color: var(--serious); font-size: 12.5px; margin: 4px 0 8px; }
.stat-l { font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-3); font-weight: 600;
  margin: 34px 0 10px; padding-top: 14px; border-top: 1px solid var(--hairline); }
.allclear { color: var(--ink-3); font-size: 14px; }
.pid, .oid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink-3); white-space: nowrap; }
.spend { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--hairline); white-space: nowrap; }
.badge.serious { color: var(--serious); }
.badge.quiet { color: var(--ink-3); }
.meta, .rmeta { color: var(--ink-3); font-size: 12px; }
.attr { color: var(--ink-3); font-size: 11.5px; }

/* ---- ship-next hero ---- */
.hero-card { background: var(--surface); border: 1px solid var(--hairline); border-left: 3px solid var(--good-text);
  border-radius: var(--radius-card); padding: 18px 22px; margin: 12px 0; }
.hero-card header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.htitle { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
.decision { margin: 10px 0 6px; color: var(--ink-2); }
.dmark { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--good-text); font-weight: 650; margin-right: 8px; }

/* ---- charter ---- */
.charter .citem { margin: 3px 0; font-size: 13px; color: var(--ink-2); }
.crank { color: var(--link); font-weight: 650; font-size: 12px; margin: 0 6px 0 8px; }
.cstate { color: var(--ink); }

/* ---- ranked rows ---- */
.prow { border-bottom: 1px solid var(--hairline); }
.prow summary { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 9px 4px; cursor: pointer; list-style: none; }
.prow summary::-webkit-details-marker { display: none; }
/* The one place the estate's --accent belongs: it is a hover SURFACE in
   shadcn's vocabulary, which is exactly this row's job. Aliasing it here rather
   than to --surface matters — --card and --background are the same white in
   the light palette, so a --surface hover would be no hover at all. */
.prow summary:hover { background: var(--accent); }
.rank { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 12px; min-width: 20px; text-align: right; }
.rtitle { font-weight: 500; }
.rmeta { margin-left: auto; text-align: right; }
.explain { flex-basis: 100%; color: var(--ink-3); font-size: 12px; padding-left: 30px; }

/* ---- shared detail ---- */
details.more { margin-top: 10px; }
details.more summary, .prow > summary { font-size: 13.5px; }
details.more summary { font-size: 12px; color: var(--ink-3); cursor: pointer; }
.body { white-space: pre-wrap; color: var(--ink-2); font-size: 13px; background: var(--page);
  border: 1px solid var(--hairline); border-radius: var(--radius-inner); padding: 10px 14px; margin: 8px 0; }
.prow .body { background: var(--surface); }
.park { color: var(--ink-2); font-size: 12.5px; margin: 4px 0; }
.cite { font-size: 12.5px; color: var(--ink-2); margin: 3px 0; }
.claim { display: block; font-size: 12.5px; color: var(--ink-2); margin: 3px 0; }
.tl-wrap { margin: 10px 0 4px; border-left: 2px solid var(--hairline); padding-left: 14px; }
.tl { margin: 7px 0; font-size: 12.5px; }
.tl-when { color: var(--ink-3); margin-right: 8px; font-variant-numeric: tabular-nums; }
.tl-who { color: var(--link); font-weight: 600; margin-right: 8px; }
.tl-what { color: var(--ink-3); font-style: italic; margin-right: 8px; }
.tl-note { color: var(--ink-2); display: block; margin-top: 1px; }
footer { margin-top: 48px; color: var(--ink-3); font-size: 11.5px; border-top: 1px solid var(--hairline); padding-top: 12px; }
`;

// Refresh by replacement, preserving scroll and open disclosures.
const JS = `
let last = Date.now();
setInterval(async () => {
  try {
    const r = await fetch(location.pathname, { cache: 'no-store' });
    if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.id).filter(Boolean));
    for (const id of open) doc.getElementById(id)?.setAttribute('open', '');
    const y = scrollY;
    document.body.replaceWith(doc.body);
    scrollTo(0, y);
    last = Date.now();
  } catch {}
}, 15000);
setInterval(() => {
  const el = document.getElementById('age');
  if (el) el.textContent = Math.round((Date.now() - last) / 1000) + 's ago';
}, 5000);
`;

createServer((req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e));
  }
}).listen(port, host, () => console.log(`Roadmap view: http://localhost:${port} — db: ${dbPath}`));
