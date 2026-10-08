# tldraw Topology MCP

A shared local tldraw topology service with a persistent HTTP daemon and a thin stdio MCP adapter.

## Architecture

- `daemon.mjs` owns the authoritative tldraw document store, persistence, browser/static HTTP service, synchronization API, page/view projections, health endpoint, and topology mutations.
- `server.mjs` is a thin stdio MCP adapter. It exposes twelve tools and forwards requests to the daemon over HTTP.
- The browser publishes ephemeral Human View state (current page, camera, viewport, selection, visible shapes, and a viewport PNG). This is a projection of the authoritative document, not a second data authority.
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

### Read surfaces

- `topology_get` — page-scoped topology by default; omit `page_id` to use the active browser page. Use `scope=document` only for an explicit cross-page document view.
- `page_list` — list document pages and identify the page reported by the active browser view.
- `page_get` — read one page as compact summaries or exact page-scoped tldraw records.
- `view_get` — read the active browser page, camera, viewport, selection, visible shapes, and visible topology projection.
- `view_snapshot` — return a PNG of the latest coherent active browser viewport plus matching view metadata.

### Mutations

- `node_add`, `node_update`, `node_delete`
- `edge_add`, `edge_update`, `edge_delete`
- `topology_clear`

Page semantics are closed by default:

- `node_add` targets an explicit `page_id` or the active browser page.
- `edge_add` requires both endpoint nodes to belong to the same page; cross-page topology edges are rejected.
- updates and deletes derive the owning page from the target shape identity.
- `topology_clear` clears one explicit/current page by default; whole-document clear requires explicit `scope=document`.
- if no active browser page is available, page-defaulting operations fail closed unless `page_id` is provided.

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
- `GET /api/state` — complete authoritative tldraw document snapshot.
- `GET /api/changes?since=<revision>` — incremental browser synchronization.
- `POST /api/changes` — browser document changes.
- `GET /api/view` — latest eligible browser Human View metadata.
- `POST /api/view` — publish browser Human View metadata and coherent viewport snapshot.
- `DELETE /api/view?clientId=<id>` — unregister a browser view client.
- `POST /api/topology/command` — semantic topology/page/view command endpoint used by the MCP adapter.

## Persistence and concurrency

The daemon is the single writer for the authoritative local document. Runtime document state is stored in `data/store.json` by default and is intentionally excluded from source control. Writes use a temporary file followed by rename. Semantic mutations are serialized so multiple MCP adapters can safely share one daemon.

Browser Human View state is intentionally ephemeral and in-memory. View snapshots are accepted only when their `viewToken` matches the latest visual/document state for that browser client, preventing an older image export from being paired with newer page/camera metadata.

## Service supervision

Operating-system service registration, startup policy, and external supervision are intentionally outside this repository. The daemon is designed to be hosted by a generic supervisor without coupling that supervisor to the MCP adapter.

## Version

Current release: `v0.1.0`.

## Upstream

The browser UI is built with the tldraw SDK. See the upstream tldraw project for its licensing and trademark terms.
