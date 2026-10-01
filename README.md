# tldraw Topology MCP

A shared local tldraw topology service with a persistent HTTP daemon and a thin stdio MCP adapter.

## Architecture

- `daemon.mjs` owns the tldraw store, persistence, browser/static HTTP service, sync API, health endpoint, and topology mutations.
- `server.mjs` is a thin stdio MCP adapter. It exposes eight topology tools and forwards calls to the daemon over HTTP.
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

`topology_get`, `node_add`, `node_update`, `node_delete`, `edge_add`, `edge_update`, `edge_delete`, `topology_clear`.

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
- `GET /api/state` — complete tldraw document snapshot.
- `GET /api/changes?since=<revision>` — incremental browser synchronization.
- `POST /api/changes` — browser document changes.
- `POST /api/topology/command` — semantic topology command endpoint used by the MCP adapter.

## Persistence and concurrency

The daemon is the single writer for the authoritative local document. Runtime state is stored in `data/store.json` by default and is intentionally excluded from source control. Writes use a temporary file followed by rename. Semantic mutations are serialized so multiple MCP adapters can safely share one daemon.

## Service supervision

Operating-system service registration, startup policy, and external supervision are intentionally outside this repository. The daemon is designed to be hosted by a generic supervisor without coupling that supervisor to the MCP adapter.

## Version

Current release: `v0.1.0`.

## Upstream

The browser UI is built with the tldraw SDK. See the upstream tldraw project for its licensing and trademark terms.
