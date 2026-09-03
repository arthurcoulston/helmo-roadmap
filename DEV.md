# DEV — coding context for helmo-roadmap

The layer above the ticket: Helmo records work being done, this records work
worth doing — parked, shaped, ranked, declared go. Product intent and the
full design: `PRODUCT.md`; the charter template ships with the product
(`CHARTER-TEMPLATE.md`). Built as a sibling of Helmo in Helmo's idiom:
append-only event log, materialized state, `.immediate()` write transactions
(same H-134 trap), the H-71 markup gate, actor provenance on every write.

## Architecture (src/)

- `store.ts` — SQLite store (better-sqlite3): projects, deps, claims,
  citations, objectives, bets, all materialized from an append-only event
  log (`rebuild()` is the invariant, tests enforce it — every side effect
  of a write lives in an apply* function, or replay silently diverges).
  Derived rank: facts set the tier (ship_next · ready · shaping · blocked ·
  parked), judgments order within it (best cited objective rank, latest
  value claim, effort), every rank carries a one-line explanation; shipped
  and archived projects are off the ranked list. Rules the store enforces,
  not just the docs: judgments never land without a reason; 'ready' needs
  an agent other than the last shaper (the human is never gated); ship_next
  — the work phase, ladder v2 (H-672) — only via `setShipNext` with
  `decided_by`, several may hold it and the returned count is the
  resistance signal; the shipped statuses (shipped_watching,
  shipped_stable) are reachable only from ship_next, so nothing ships
  without the human's go; archived is the one terminal status and is
  permanent; actuals are absolute rollups recorded from Helmo's meter,
  never deltas. Pre-v2 events ('shipping'/'shipped'/'abandoned' statuses,
  ship_next 'demoted' payloads) still replay correctly — never strip that
  handling.
- `tools.ts` — the 10-tool MCP surface, descriptions are
  guidance-as-deployed (Helmo's rule). v1 postures baked into them:
  ship_next is FYI to the fleet, not tasking; the charter is derived from
  the human's document, never authored here.
- `server.ts` — MCP stdio entry. Store at `~/.helmo-roadmap/roadmap.db`
  (`ROADMAP_DB` overrides); identity from `ROADMAP_ACTOR`, falling back to
  `HELMO_ACTOR` so estates provisioned for Helmo need no second variable.
- `view.ts` — read-only dashboard at :4410 (`ROADMAP_VIEW_PORT`). Ship-next
  expanded on top, charter strip, everything else collapsed in derived rank
  order. No write routes at all — unlike Helmo's view there is no answer
  surface; add none.
- `types.ts` — the vocabulary. Gates and stances are named in PRODUCT.md
  but deliberately absent from v1 behavior; leave the room, don't fill it.

## Commands

- `npm run build` (tsc → dist/), `npm test` (store suite against temp dbs).
- `npm run vendor:tokens` refreshes the vendored estate design tokens; add
  `-- --check` to fail on drift instead. See below.
- View: `node dist/view.js`; restart after rebuilding.

## The estate design tokens (R-11 H-714)

`src/estate-tokens.generated.ts` is a **vendored copy** of the estate shell's
`tokens/estate-tokens.css` — the source of the visual system every estate
surface shares. `scripts/vendor-estate-tokens.mjs` refreshes it (also
`--check`); `test/estate-tokens.test.ts` fails on drift.

Vendoring, not importing, is the point: the roadmap is published standalone, so
a clone with no estate checkout beside it must build and run unchanged. That is
also why the drift test uses `it.skipIf` rather than an early return — with no
source to compare against it reports **skipped**, which is visible in the run
summary, where a `console.log` from a passing test is not.

**What was adopted, and what was not.** `view.ts` keeps every one of its own
token names and not one of its rules changed in meaning; the aliases at the top
of `CSS` are the whole seam, so a look ratified upstream restyles this page
without it being touched. Adopted: surfaces (`--page`, `--surface`), the ink
ladder, `--hairline`, and the radius ramp (`--radius-card` / `-inner` are the
estate's `--radius` × 1 / 0.8). The middle ink is mixed from the estate's two,
since shadcn has no third step.

Status colours and the interactive `--link` blue were held back at first —
shadcn's neutral base ships no status ramp. The estate grew both of its own in
H-771, so they alias like everything else now and the dark overrides for them
are gone: the estate's ramp is themed. `--serious` moved in that swap, from
`#ec835a` (2.64:1 on white — a chart mark in the reference palette, and this
page renders it as an alarm note and a badge) to the estate's deepened light
step. Its own `--accent` is still a hover *surface*, not an interactive colour,
and the one place that `--accent` does
belong is `.prow summary:hover`, which is exactly a hover surface — and it has
to be that rather than `--surface`, because `--card` and `--background` are the
same white in the light palette, so a `--surface` hover would be no hover at
all.

Two collisions had to be resolved, because the vendored file lands on `:root`
ahead of the roadmap's own block: `--muted` and `--accent` exist in both with
*different meanings* (surface vs text; hover surface vs link). The roadmap's
are now `--ink-3` and `--link`. Its `--border` folded into `--hairline` — the
estate has one border token and the two resolved to it.

**One trap, learned the hard way here.** An alias that comes out
self-referential (`--hairline: var(--hairline)`) is *guaranteed-invalid* in
CSS: the property ends up with no value, every rule using it is dropped, and
nothing goes red — the page just quietly loses all its borders. It shipped that
way for one render and only a pixel sample caught it. `test/estate-tokens.test.ts`
now asserts no seam alias resolves to itself, in this repo and in Helmo.

## The Helmo seam

Three additions in the helmo repo (H-172), a public API commitment — resist
widening: a `project` tag on tickets (the join key for rollups), a `project`
filter on the ticket query, and the standing notice on queue responses
(`helmo_set_notice`, human/orchestrator only). The roadmap holds no code
path into Helmo: in v1 Bosun's sweep is the client — it reads metered
cost from Helmo tickets tagged with the project id and records the rollup
via `roadmap_record_actual`.

The notice is the half of the seam an agent cannot close (H-324). Every
`roadmap_set_ship_next` response says to update it, but `helmo_set_notice`
takes human/orchestrator writes only and a loop signs as agent — so a
declaration made from a loop leaves the notice stale until someone updates
it beside the human. Bosun's sweep therefore *detects* the drift and says
so; the correction is a desk-session act. Two caveats on the rollup itself:
desk sessions are unmetered, so a human-heavy project rolls up $0 (record
nothing rather than "cheap"), and list rows carry no cost, so the sum is one
`helmo-cli get` per tagged ticket — cheap in one shell pass, but the reason
a programmatic client stays on the v2 list.

## v2 parked in H-172

Gates/stances behavior, a programmatic roadmap→Helmo client, automatic
charter re-derivation, remote HTTP entry, estimation-learning analytics,
hygiene tooling, a CLI.
