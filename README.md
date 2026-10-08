# tldraw Topology MCP

A shared local tldraw topology service with a persistent HTTP daemon and a thin stdio MCP adapter.

## Architecture

- `daemon.mjs` owns the authoritative tldraw document store, persistence, browser/static HTTP service, synchronization API, page-scoped topology projections, ephemeral browser-view state, health endpoint, and topology mutations.
- `server.mjs` is a thin stdio MCP adapter. It exposes page/topology tools plus an explicit browser View surface.
- tldraw Pages are first-class document scope boundaries. Normal topology reads and page-targeted mutations operate on one explicit `page_id`.
- Browser Views are ephemeral projections only. Each live browser instance publishes a separate `view_id` with its current page, camera, viewport, selection, visible shapes, and a coherent viewport PNG.
- The MCP adapter does not own the daemon lifecycle. MCP clients can connect and disconnect without destroying the shared canvas state.

## Install and build

```bash
npm install
npm run build
```

Run the long-lived daemon:

```bash
npm start
```

Run the stdio MCP adapter in an MCP host:

```bash
npm run mcp
```

## MCP tools

### Page discovery and topology

- `page_list` — list document pages with stable page IDs, names, order, and topology node/edge counts.
- `topology_get(page_id)` — read the topology contained in exactly one page.

### Human View surface

- `view_list` — list live browser views. No global "current browser" is assumed.
- `view_get(view_id)` — read one explicit browser view: page, camera, viewport, selection, visible shapes, and visible topology.
- `view_snapshot(view_id)` — return the latest coherent PNG rendering of that exact browser viewport.

A View is never an authority for document facts. It is an ephemeral projection of the authoritative tldraw document and expires automatically if its browser stops publishing heartbeats.

### Mutations

- `node_add(page_id, ...)` — add a topology node to exactly one page.
- `node_update(id, ...)` / `node_delete(id)` — derive the owning page from the existing node.
- `edge_add(from, to, ...)` — derive the page from the endpoints and reject cross-page edges.
- `edge_update(id, ...)` / `edge_delete(id)` — derive the owning page from the existing edge.
- `topology_clear(page_id)` — clear topology content from exactly one page while preserving the page, non-topology containers, and every other page.

Page identity is authoritative by `page_id`; page names are display metadata only. Shape ownership is resolved through the full tldraw parent ancestry, so shapes nested under frames or groups still belong to the correct page.

There is intentionally no implicit current-page fallback and no whole-document topology read/clear compatibility mode. View operations likewise require an explicit `view_id`; with multiple browsers open, every browser remains independently addressable.

## Daemon configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TLDRAW_HOST` | `127.0.0.1` | HTTP bind address |
| `TLDRAW_PORT` | `5173` | HTTP port |
| `TLDRAW_DATA_DIR` | `<project>/data` | Directory containing `store.json` |
| `TLDRAW_STORE_FILE` | `<data dir>/store.json` | Exact store path; overrides `TLDRAW_DATA_DIR` |
| `TLDRAW_DIST_DIR` | `<project>/dist` | Built browser assets |
| `TLDRAW_CANVAS_URL` | derived local URL | URL reported to MCP clients |

The default bind is loopback. External interface exposure belongs to deployment configuration and is not hard-coded in the application.

## MCP adapter configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TLDRAW_TOPOLOGY_DAEMON_URL` | `http://127.0.0.1:5173` | Daemon base URL |
| `TLDRAW_TOPOLOGY_TIMEOUT_MS` | `10000` | Per-call HTTP timeout |

## HTTP endpoints

- `GET /healthz` — daemon health and current revision.
- `GET /api/state` — complete authoritative tldraw document snapshot for synchronization/recovery.
- `GET /api/changes?since=<revision>` — incremental browser synchronization.
- `POST /api/changes` — browser document changes.
- `POST /api/view` — publish one ephemeral browser View and optional coherent PNG snapshot.
- `DELETE /api/view?viewId=<id>` — unregister one browser View.
- `POST /api/topology/command` — semantic page/topology/view command endpoint used by the MCP adapter.

The complete `/api/state` document snapshot remains an internal synchronization/recovery surface. It is not the normal MCP topology read surface.

## Persistence and concurrency

The daemon is the single writer for the authoritative local document. Runtime document state is stored in `data/store.json` by default and is intentionally excluded from source control. Writes use a temporary file followed by rename. Semantic mutations are serialized so multiple MCP adapters can safely share one daemon.

Browser View state is intentionally memory-only and is never persisted into the document. Each snapshot carries the same `viewToken` as the page/camera/selection state it represents; stale screenshots are rejected by the read surface.

## Service supervision

Operating-system service registration, startup policy, and external supervision are intentionally outside this repository. The daemon is designed to be hosted by a generic supervisor without coupling that supervisor to the MCP adapter.

## Version

Current release: `v0.1.0`.

## Upstream

The browser UI is built with the tldraw SDK. See the upstream tldraw project for its licensing and trademark terms.
