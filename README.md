# tldraw Topology MCP

A shared local tldraw topology service with a persistent HTTP daemon and a thin stdio MCP adapter.

## Architecture

- `daemon.mjs` owns the authoritative tldraw document store, persistence, browser/static HTTP service, synchronization API, page-scoped topology projections, health endpoint, and topology mutations.
- `server.mjs` is a thin stdio MCP adapter. It exposes nine page/topology tools and forwards requests to the daemon over HTTP.
- tldraw Pages are first-class MCP scope boundaries. Normal topology reads and page-targeted mutations operate on one explicit `page_id`.
- Geo nodes and Arrow edges expose their editable tldraw presentation properties through the same MCP tools; there is no separate style state plane.
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
- `topology_get(page_id)` — read exactly one Page. Geo nodes and Arrow edges include their editable presentation properties so writes can be verified through the same read surface.

### Geo node editing

`node_add(page_id, ...)` and `node_update(id, ...)` support:

- geometry: `x`, `y`, `w`, `h`, `rotation`, `opacity`, `scale`, `flipX`, `flipY`
- Geo shape: `geo`
- outline / fill: `color`, `fill`, `dash`, `size`
- label: `label`, `labelColor`, `font`, `align`, `verticalAlign`
- whole-label rich text: `bold`, `italic`, `bulletList`, `highlight`
- link: `url`

Supported Geo values:

```text
cloud rectangle ellipse triangle diamond pentagon hexagon octagon star
rhombus rhombus-2 oval trapezoid arrow-right arrow-left arrow-up arrow-down
x-box check-box heart
```

### Arrow edge editing

`edge_add(from, to, ...)` and `edge_update(id, ...)` support:

- arrow form: `kind`, `bend`, `elbowMidPoint`
- arrowheads: `arrowheadStart`, `arrowheadEnd`
- line / head appearance: `color`, `fill`, `dash`, `size`, `opacity`, `scale`, `rotation`
- label: `label`, `labelColor`, `font`, `labelPosition`
- whole-label rich text: `bold`, `italic`, `bulletList`, `highlight`

Arrow kinds are `arc` and `elbow`.

Arrowhead values:

```text
arrow triangle square dot pipe diamond inverted bar none
```

### Shared style values

Colors:

```text
black grey light-violet violet blue light-blue yellow orange green
light-green light-red red white
```

Dash:

```text
draw solid dashed dotted none
```

Fill:

```text
none semi solid pattern fill lined-fill
```

Size:

```text
s m l xl
```

Font:

```text
draw sans serif mono
```

Horizontal alignment:

```text
start middle end
```

Vertical alignment:

```text
start middle end
```

### Deletion and clearing

- `node_delete(id)` — delete a topology node and connected topology arrows.
- `edge_delete(id)` — delete one topology arrow and its bindings.
- `topology_clear(page_id)` — clear topology Geo/Arrow content from exactly one Page while keeping the Page itself, non-topology containers, and every other Page unchanged.

Page identity is authoritative by `page_id`; page names are display metadata only. Shape ownership is resolved through the full tldraw parent ancestry, so shapes nested under frames or groups still belong to the correct page.

There is intentionally no implicit current-browser-page fallback, no whole-document topology read/clear compatibility mode, and no continuous browser View bridge.

## Editing semantics

All update fields are optional. An update changes only the supplied properties.

The MCP does not maintain a parallel style model. It writes the same native tldraw Geo / Arrow properties used by the browser UI. Whole-label rich-text operations modify the shape's native `richText`; they do not create separate bold/italic/list/highlight flags in persisted data.

`topology_get` summarizes whole-label rich-text state as `true`, `false`, or `mixed` where applicable.

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
