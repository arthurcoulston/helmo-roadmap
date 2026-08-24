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
  log (`rebuild()` is the invariant, tests enforce it). Derived rank:
  facts set the tier (ship_next · shipping · ready · shaping · blocked ·
  parked), judgments order within it (best cited objective rank, latest
  value claim, effort), every rank carries a one-line explanation. Rules
  the store enforces, not just the docs: judgments never land without a
  reason; 'ready' needs an agent other than the last shaper (the human is
  never gated); ship_next only via `setShipNext` with `decided_by` — exactly
  one, the previous holder steps back to ready; terminal is permanent;
  actuals are absolute rollups recorded from Helmo's meter, never deltas.
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
- View: `node dist/view.js`; restart after rebuilding.

## The Helmo seam

Three additions in the helmo repo (H-172), a public API commitment — resist
widening: a `project` tag on tickets (the join key for rollups), a `project`
filter on the ticket query, and the standing notice on queue responses
(`helmo_set_notice`, human/orchestrator only). The roadmap holds no code
path into Helmo: in v1 Bosun's sweep is the client — it reads metered
cost from Helmo tickets tagged with the project id and records the rollup
via `roadmap_record_actual`, and relays the human's ship-next call into
the notice.

## v2 parked in H-172

Gates/stances behavior, a programmatic roadmap→Helmo client, automatic
charter re-derivation, remote HTTP entry, estimation-learning analytics,
hygiene tooling, a CLI.
