# tldraw Topology MCP

A shared local tldraw topology service with a persistent HTTP daemon and a thin stdio MCP adapter.

## Architecture

- `daemon.mjs` owns the authoritative tldraw document store, persistence, browser/static HTTP service, synchronization API, page-scoped topology projections, health endpoint, and topology mutations.
- `server.mjs` is a thin stdio MCP adapter. It exposes nine topology tools and forwards requests to the daemon over HTTP.
- tldraw Pages are first-class MCP scope boundaries. Normal topology reads and page-targeted mutations operate on one explicit `page_id`.
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

### Page discovery and reads

- `page_list` — list tldraw document pages with stable page IDs, names, order, and topology node/edge counts.
- `topology_get(page_id)` — read the topology contained in exactly one page.

### Mutations

- `node_add(page_id, ...)` — add a topology node to exactly one page.
- `node_update(id, ...)` / `node_delete(id)` — derive the owning page from the existing node.
- `edge_add(from, to, ...)` — derive the page from the endpoints and reject cross-page edges.
- `edge_update(id, ...)` / `edge_delete(id)` — derive the owning page from the existing edge.
- `topology_clear(page_id)` — clear topology content from exactly one page while preserving the page and every other page.

Page identity is authoritative by `page_id`; page names are display metadata only. Shape ownership is resolved through the full tldraw parent ancestry, so shapes nested under frames or groups still belong to the correct page.

There is intentionally no implicit "current browser page" fallback and no whole-document topology read/clear compatibility mode. Browser session state such as current page, camera, selection, viewport, and screenshots is a separate ephemeral View concern and is not part of this page-scoped MCP surface.

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
- `POST /api/topology/command` — semantic page/topology command endpoint used by the MCP adapter.

The complete `/api/state` document snapshot remains an internal synchronization/recovery surface. It is not the normal MCP topology read surface.

## Persistence and concurrency

The daemon is the single writer for the authoritative local document. Runtime document state is stored in `data/store.json` by default and is intentionally excluded from source control. Writes use a temporary file followed by rename. Semantic mutations are serialized so multiple MCP adapters can safely share one daemon.

## Service supervision

Operating-system service registration, startup policy, and external supervision are intentionally outside this repository. The daemon is designed to be hosted by a generic supervisor without coupling that supervisor to the MCP adapter.

## Version

Current release: `v0.1.0`.

## Upstream

The browser UI is built with the tldraw SDK. See the upstream tldraw project for its licensing and trademark terms.
