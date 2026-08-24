# Helmo Roadmap

*Working title — the name is deliberately unsettled.*

The layer above the ticket. [Helmo](https://github.com/arthurcoulston/helmo)
records work **being done**; this records work **worth doing** — where an idea
gets parked, fleshed out, costed, ranked, and eventually declared go. Separate
products, separate stores: together they read as one system, apart each stands
alone.

The full design is [PRODUCT.md](PRODUCT.md). The charter template that ships
with the product is [CHARTER-TEMPLATE.md](CHARTER-TEMPLATE.md).

## Run

- `npm install && npm run build`
- MCP server (stdio): `node dist/server.js` — store at
  `~/.helmo-roadmap/roadmap.db` (`ROADMAP_DB` overrides); writer identity from
  `ROADMAP_ACTOR` or `HELMO_ACTOR` (JSON), or a per-call `actor` param.
- Read-only view: `node dist/view.js` — `http://localhost:4410`
  (`ROADMAP_VIEW_PORT`).
- `npm test`

## The shape

- **Getting an idea in costs nothing** — a title, ideally a sentence. Bad
  ideas belong here, ranked low; that is the process succeeding.
- **Rank is derived, never hand-set.** Facts (ship-next, in motion, ready,
  shaping, blocked, parked) set the tier; attributed judgments (value, effort)
  order within it. Every rank explains itself in one line.
- **Effort is predicted in dollars** and checked against the metered actual
  rolled up from the project's Helmo tickets — falling costs re-sort the list
  without anyone changing their mind about value.
- **Exactly one ship_next**, and it is the human's recorded decision.
- **The charter is the one thing the human writes and agents only read** —
  the store holds a projection (objectives and bets) with provenance back to
  the human's own document.
