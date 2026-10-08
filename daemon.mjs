import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
	createTLStore,
	createShapeId,
	createBindingId,
	toRichText,
	DocumentRecordType,
	PageRecordType,
	TLDOCUMENT_ID,
	getIndexAbove,
} from 'tldraw'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOST = (process.env.TLDRAW_HOST ?? '127.0.0.1').trim() || '127.0.0.1'
const rawPort = Number(process.env.TLDRAW_PORT ?? 5173)
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) throw new Error(`Invalid TLDRAW_PORT: ${process.env.TLDRAW_PORT}`)
const PORT = rawPort
const DIST = resolve((process.env.TLDRAW_DIST_DIR ?? '').trim() || join(ROOT, 'dist'))
const STORE_FILE = resolve(
	(process.env.TLDRAW_STORE_FILE ?? '').trim()
		|| join(resolve((process.env.TLDRAW_DATA_DIR ?? '').trim() || join(ROOT, 'data')), 'store.json'),
)
const DATA_DIR = dirname(STORE_FILE)
const JOURNAL_LIMIT = 2000

function urlHost(host) {
	if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function normalizedCanvasUrl() {
	const explicit = (process.env.TLDRAW_CANVAS_URL ?? '').trim()
	const value = explicit || `http://${urlHost(HOST)}:${PORT}/`
	return value.endsWith('/') ? value : `${value}/`
}

const CANVAS_URL = normalizedCanvasUrl()

const GEO_DEFAULTS = {
	geo: 'rectangle', dash: 'draw', growY: 0, url: '', scale: 1, flipX: false, flipY: false,
	color: 'black', labelColor: 'black', fill: 'none', size: 'm', font: 'draw',
	align: 'middle', verticalAlign: 'middle', richText: toRichText(''),
}
const ARROW_DEFAULTS = {
	kind: 'arc', elbowMidPoint: 0.5, dash: 'draw', size: 'm', fill: 'none', color: 'black',
	labelColor: 'black', bend: 0, start: { x: 0, y: 0 }, end: { x: 2, y: 0 },
	arrowheadStart: 'none', arrowheadEnd: 'arrow', richText: toRichText(''), labelPosition: 0.5,
	font: 'draw', scale: 1,
}
const BINDING_DEFAULTS = {
	normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none',
}

const store = createTLStore()
let revision = 0
let journal = []
let mutationTail = Promise.resolve()


function seedBlankStore() {
	if (store.allRecords().length) return false
	const pageId = PageRecordType.createId('page')
	store.put([
		DocumentRecordType.create({ id: TLDOCUMENT_ID }),
		PageRecordType.create({ id: pageId, name: 'Page 1', index: 'a1' }),
	])
	return true
}

async function loadPersistentStore() {
	await mkdir(DATA_DIR, { recursive: true })
	let loaded = false
	if (existsSync(STORE_FILE)) {
		const saved = JSON.parse(await readFile(STORE_FILE, 'utf8'))
		if (saved?.snapshot) {
			store.loadStoreSnapshot(saved.snapshot)
			loaded = true
		}
		revision = Number.isInteger(saved?.revision) ? saved.revision : 0
	}
	const seeded = seedBlankStore()
	if (!loaded || seeded) await persist()
}

async function persist() {
	const payload = JSON.stringify({ revision, snapshot: store.getStoreSnapshot('document') }, null, 2)
	const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, payload, 'utf8')
	await rename(tmp, STORE_FILE)
}

function serializeMutation(fn) {
	const next = mutationTail.then(fn, fn)
	mutationTail = next.then(() => undefined, () => undefined)
	return next
}

function nextIndex(targetPageId) {
	pageRecordById(targetPageId)
	const { shapes } = pageShapesAndBindings(targetPageId)
	if (!shapes.length) return 'a1'
	const last = shapes.map((s) => s.index).sort().at(-1)
	return getIndexAbove(last)
}

function normalizeChanges(changes = {}) {
	return {
		added: Array.isArray(changes.added) ? changes.added : [],
		updated: Array.isArray(changes.updated) ? changes.updated : [],
		removed: Array.isArray(changes.removed) ? changes.removed : [],
	}
}

function applyRecords(changes) {
	const c = normalizeChanges(changes)
	store.mergeRemoteChanges(() => {
		if (c.added.length || c.updated.length) store.put([...c.added, ...c.updated])
		if (c.removed.length) {
			const existing = c.removed.filter((id) => store.has(id))
			if (existing.length) store.remove(existing)
		}
	})
	return c
}

async function commitUnsafe(changes) {
	const normalized = applyRecords(changes)
	revision += 1
	const event = { revision, ...normalized }
	journal.push(event)
	if (journal.length > JOURNAL_LIMIT) journal = journal.slice(-JOURNAL_LIMIT)
	await persist()
	return event
}


function canServeSince(since) {
	if (since === revision) return true
	if (since > revision) return false
	if (!journal.length) return since === revision
	return since >= journal[0].revision - 1
}

function eventsSince(since) {
	return journal.filter((event) => event.revision > since)
}

function plainText(richText) {
	if (!richText || typeof richText !== 'object') return ''
	const walk = (node) => {
		if (!node || typeof node !== 'object') return ''
		if (typeof node.text === 'string') return node.text
		if (!Array.isArray(node.content)) return ''
		const separator = node.type === 'doc' ? '\n' : ''
		return node.content.map(walk).filter(Boolean).join(separator)
	}
	return walk(richText).trim()
}

function shapeById(id) {
	if (typeof id !== 'string' || !id) throw new Error('Shape id is required')
	const full = id.startsWith('shape:') ? id : `shape:${id}`
	const shape = store.get(full)
	if (!shape || shape.typeName !== 'shape') throw new Error(`Shape not found: ${id}`)
	return shape
}

function pageIdForShape(shape) {
	let parentId = shape.parentId
	const seen = new Set()
	while (typeof parentId === 'string' && !seen.has(parentId)) {
		if (parentId.startsWith('page:')) {
			pageRecordById(parentId)
			return parentId
		}
		seen.add(parentId)
		const parent = store.get(parentId)
		if (!parent || parent.typeName !== 'shape') break
		parentId = parent.parentId
	}
	throw new Error(`Shape is not attached to a tldraw page: ${shape.id}`)
}

function bindingsForArrow(arrowId) {
	return store.allRecords().filter((r) => r.typeName === 'binding' && r.type === 'arrow' && r.fromId === arrowId)
}

function pageRecordById(id) {
	const page = store.get(id)
	if (!page || page.typeName !== 'page') throw new Error(`Page not found: ${id}`)
	return page
}

function pageRecords() {
	return store.allRecords()
		.filter((r) => r.typeName === 'page')
		.sort((a, b) => String(a.index).localeCompare(String(b.index)))
}

function shapeBelongsToPage(shape, targetPageId, shapesById) {
	let parentId = shape.parentId
	const seen = new Set()
	while (typeof parentId === 'string' && !seen.has(parentId)) {
		if (parentId === targetPageId) return true
		seen.add(parentId)
		const parent = shapesById.get(parentId)
		if (!parent) return false
		parentId = parent.parentId
	}
	return false
}

function pageShapesAndBindings(targetPageId) {
	const records = store.allRecords()
	const allShapes = records.filter((r) => r.typeName === 'shape')
	const shapesById = new Map(allShapes.map((shape) => [shape.id, shape]))
	const shapes = allShapes.filter((shape) => shapeBelongsToPage(shape, targetPageId, shapesById))
	const shapeIds = new Set(shapes.map((shape) => shape.id))
	const bindings = records.filter(
		(r) => r.typeName === 'binding' && (shapeIds.has(r.fromId) || shapeIds.has(r.toId)),
	)
	return { shapes, bindings }
}

function topologyForPage(targetPageId) {
	const { shapes } = pageShapesAndBindings(targetPageId)
	const pageShapeIds = new Set(shapes.map((shape) => shape.id))
	const nodes = shapes.filter((s) => s.type === 'geo').map((s) => ({
		id: s.id,
		label: plainText(s.props?.richText),
		x: s.x,
		y: s.y,
		w: s.props?.w ?? 100,
		h: s.props?.h ?? 100,
		geo: s.props?.geo ?? 'rectangle',
	}))
	const edges = shapes.filter((s) => s.type === 'arrow').map((s) => {
		const bs = bindingsForArrow(s.id)
		const start = bs.find((b) => b.props?.terminal === 'start')
		const end = bs.find((b) => b.props?.terminal === 'end')
		return {
			id: s.id,
			from: pageShapeIds.has(start?.toId) ? start.toId : null,
			to: pageShapeIds.has(end?.toId) ? end.toId : null,
			label: plainText(s.props?.richText),
		}
	})
	return { nodes, edges }
}

function pageListView() {
	return {
		revision,
		pages: pageRecords().map((page) => {
			const topology = topologyForPage(page.id)
			return {
				id: page.id,
				name: page.name,
				index: page.index,
				nodeCount: topology.nodes.length,
				edgeCount: topology.edges.length,
			}
		}),
		url: CANVAS_URL,
	}
}

function resolvePageId(requestedPageId) {
	if (typeof requestedPageId !== 'string' || !requestedPageId) {
		throw new Error('page_id is required')
	}
	pageRecordById(requestedPageId)
	return requestedPageId
}

function topologyView({ page_id }) {
	const targetPageId = resolvePageId(page_id)
	const page = pageRecordById(targetPageId)
	return {
		revision,
		page: { id: page.id, name: page.name, index: page.index },
		...topologyForPage(targetPageId),
		url: CANVAS_URL,
	}
}

async function addNode({ label, page_id, x = 100, y = 100, w = 240, h = 100 }) {
	const targetPageId = resolvePageId(page_id)
	const id = createShapeId(`node-${randomUUID()}`)
	const record = store.schema.types.shape.create({
		id,
		type: 'geo',
		parentId: targetPageId,
		index: nextIndex(targetPageId),
		x,
		y,
		props: { ...GEO_DEFAULTS, w, h, richText: toRichText(label) },
	})
	await commitUnsafe({ added: [record] })
	return { id, pageId: targetPageId, revision }
}

async function updateNode({ id, label, x, y, w, h }) {
	const node = shapeById(id)
	if (node.type !== 'geo') throw new Error(`${node.id} is not a topology node`)
	const targetPageId = pageIdForShape(node)
	const next = {
		...node,
		x: x ?? node.x,
		y: y ?? node.y,
		props: {
			...node.props,
			...(w === undefined ? {} : { w }),
			...(h === undefined ? {} : { h }),
			...(label === undefined ? {} : { richText: toRichText(label) }),
		},
	}
	await commitUnsafe({ updated: [next] })
	return { id: node.id, pageId: targetPageId, revision }
}

async function deleteEdgeById(edgeId) {
	const edge = shapeById(edgeId)
	if (edge.type !== 'arrow') throw new Error(`${edge.id} is not a topology edge`)
	const targetPageId = pageIdForShape(edge)
	const bindings = bindingsForArrow(edge.id)
	await commitUnsafe({ removed: [edge.id, ...bindings.map((b) => b.id)] })
	return { id: edge.id, pageId: targetPageId, revision }
}

async function deleteNode({ id }) {
	const node = shapeById(id)
	if (node.type !== 'geo') throw new Error(`${node.id} is not a topology node`)
	const targetPageId = pageIdForShape(node)
	const connectedBindings = store.allRecords().filter(
		(r) => r.typeName === 'binding' && r.type === 'arrow' && r.toId === node.id,
	)
	const edgeIds = [...new Set(connectedBindings.map((b) => b.fromId))]
	const removed = [node.id]
	for (const edgeId of edgeIds) {
		removed.push(edgeId, ...bindingsForArrow(edgeId).map((b) => b.id))
	}
	await commitUnsafe({ removed: [...new Set(removed)] })
	return { id: node.id, pageId: targetPageId, removedEdges: edgeIds, revision }
}

async function addEdge({ from, to, label = '' }) {
	const fromNode = shapeById(from)
	const toNode = shapeById(to)
	if (fromNode.type !== 'geo' || toNode.type !== 'geo') throw new Error('Edges must connect topology nodes')
	const fromPageId = pageIdForShape(fromNode)
	const toPageId = pageIdForShape(toNode)
	if (fromPageId !== toPageId) throw new Error(`Cross-page topology edges are not allowed: ${fromPageId} -> ${toPageId}`)
	const targetPageId = fromPageId
	const edgeId = createShapeId(`edge-${randomUUID()}`)
	const startX = fromNode.x + (fromNode.props?.w ?? 100) / 2
	const startY = fromNode.y + (fromNode.props?.h ?? 100) / 2
	const endX = toNode.x + (toNode.props?.w ?? 100) / 2
	const endY = toNode.y + (toNode.props?.h ?? 100) / 2
	const arrow = store.schema.types.shape.create({
		id: edgeId,
		type: 'arrow',
		parentId: targetPageId,
		index: nextIndex(targetPageId),
		x: startX,
		y: startY,
		props: {
			...ARROW_DEFAULTS,
			end: { x: endX - startX, y: endY - startY },
			richText: toRichText(label),
		},
	})
	const bindingType = store.schema.types.binding
	const startBinding = bindingType.create({
		id: createBindingId(`start-${randomUUID()}`),
		type: 'arrow', fromId: edgeId, toId: fromNode.id,
		props: { ...BINDING_DEFAULTS, terminal: 'start' },
	})
	const endBinding = bindingType.create({
		id: createBindingId(`end-${randomUUID()}`),
		type: 'arrow', fromId: edgeId, toId: toNode.id,
		props: { ...BINDING_DEFAULTS, terminal: 'end' },
	})
	await commitUnsafe({ added: [arrow, startBinding, endBinding] })
	return { id: edgeId, pageId: targetPageId, from: fromNode.id, to: toNode.id, revision }
}

async function updateEdge({ id, label }) {
	const edge = shapeById(id)
	if (edge.type !== 'arrow') throw new Error(`${edge.id} is not a topology edge`)
	const targetPageId = pageIdForShape(edge)
	const next = { ...edge, props: { ...edge.props, richText: toRichText(label) } }
	await commitUnsafe({ updated: [next] })
	return { id: edge.id, pageId: targetPageId, revision }
}

async function clearTopology({ page_id }) {
	const targetPageId = resolvePageId(page_id)
	const { shapes, bindings } = pageShapesAndBindings(targetPageId)
	const topologyShapes = shapes.filter((shape) => shape.type === 'geo' || shape.type === 'arrow')
	const topologyShapeIds = new Set(topologyShapes.map((shape) => shape.id))
	const topologyBindings = bindings.filter(
		(binding) => topologyShapeIds.has(binding.fromId) || topologyShapeIds.has(binding.toId),
	)
	const removed = [
		...new Set([
			...topologyShapes.map((shape) => shape.id),
			...topologyBindings.map((binding) => binding.id),
		]),
	]
	if (removed.length) await commitUnsafe({ removed })
	return { pageId: targetPageId, removed: removed.length, revision }
}

async function topologyCommand(name, args = {}) {
	if (name === 'topology_get') {
		await mutationTail
		return topologyView(args)
	}
	if (name === 'page_list') {
		await mutationTail
		return pageListView()
	}
	return serializeMutation(async () => {
		switch (name) {
			case 'node_add': return addNode(args)
			case 'node_update': return updateNode(args)
			case 'node_delete': return deleteNode(args)
			case 'edge_add': return addEdge(args)
			case 'edge_update': return updateEdge(args)
			case 'edge_delete': return deleteEdgeById(args.id)
			case 'topology_clear': return clearTopology(args)
			default: throw new Error(`Unknown topology command: ${name}`)
		}
	})
}

function json(res, status, body) {
	const data = Buffer.from(JSON.stringify(body))
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': data.length,
		'cache-control': 'no-store',
	})
	res.end(data)
}

async function readJson(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > 16 * 1024 * 1024) throw new Error('Request body too large')
		chunks.push(chunk)
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const mime = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

async function serveStatic(req, res, pathname) {
	const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
	const candidate = resolve(DIST, relative)
	if (candidate !== DIST && !candidate.startsWith(`${DIST}${sep}`)) return json(res, 403, { error: 'Forbidden' })
	let file = normalize(candidate)
	try {
		const info = await stat(file)
		if (info.isDirectory()) file = join(file, 'index.html')
		const data = await readFile(file)
		res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
		res.end(data)
	} catch {
		try {
			const data = await readFile(join(DIST, 'index.html'))
			res.writeHead(200, { 'content-type': mime['.html'] })
			res.end(data)
		} catch {
			json(res, 404, { error: 'Not found' })
		}
	}
}

function currentState() {
	return { revision, snapshot: store.getStoreSnapshot('document') }
}

const httpServer = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? '/', `http://${urlHost(HOST)}:${PORT}`)
		if (req.method === 'GET' && url.pathname === '/healthz') {
			return json(res, 200, { ok: true, revision })
		}
		if (req.method === 'GET' && url.pathname === '/api/state') {
			return json(res, 200, currentState())
		}
		if (req.method === 'GET' && url.pathname === '/api/changes') {
			const since = Number(url.searchParams.get('since') ?? revision)
			if (!Number.isInteger(since) || since < 0) return json(res, 400, { error: 'Invalid since revision' })
			if (!canServeSince(since)) return json(res, 200, { reset: true, ...currentState() })
			return json(res, 200, { reset: false, revision, events: eventsSince(since) })
		}
		if (req.method === 'POST' && url.pathname === '/api/changes') {
			const body = await readJson(req)
			const since = Number(body.since)
			if (!Number.isInteger(since) || since < 0) return json(res, 400, { error: 'Invalid since revision' })
			const outcome = await serializeMutation(async () => {
				if (!canServeSince(since)) return { status: 409, body: { reset: true, ...currentState() } }
				await commitUnsafe(body.changes)
				return { status: 200, body: { reset: false, revision, events: eventsSince(since) } }
			})
			return json(res, outcome.status, outcome.body)
		}
		if (req.method === 'POST' && url.pathname === '/api/topology/command') {
			const body = await readJson(req)
			if (typeof body.name !== 'string' || !body.name) return json(res, 400, { error: 'Command name is required' })
			const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {}
			const result = await topologyCommand(body.name, args)
			return json(res, 200, { result })
		}
		if (req.method === 'GET') return serveStatic(req, res, url.pathname)
		json(res, 405, { error: 'Method not allowed' })
	} catch (error) {
		json(res, 500, { error: error instanceof Error ? error.message : String(error) })
	}
})

async function main() {
	await loadPersistentStore()
	await new Promise((resolveListen, reject) => {
		httpServer.once('error', reject)
		httpServer.listen(PORT, HOST, resolveListen)
	})
	console.error(`tldraw-topology daemon ready on ${CANVAS_URL} (bind ${HOST}:${PORT}, revision ${revision})`)
}

let shuttingDown = false
async function shutdown(signal) {
	if (shuttingDown) return
	shuttingDown = true
	console.error(`tldraw-topology daemon shutting down (${signal})`)
	await new Promise((resolveClose) => httpServer.close(() => resolveClose()))
	await mutationTail
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		shutdown(signal).then(() => process.exit(0), (error) => {
			console.error('tldraw-topology shutdown failed:', error)
			process.exit(1)
		})
	})
}

main().catch((error) => {
	console.error('tldraw-topology daemon fatal:', error)
	process.exit(1)
})