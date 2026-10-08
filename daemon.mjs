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

const VIEW_ACTIVE_TTL_MS = 15_000
const VIEW_BACKGROUND_TTL_MS = 90_000
const VIEW_CLIENT_RETENTION_MS = 300_000
const viewClients = new Map()

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

function shapeSummary(shape) {
	return {
		id: shape.id,
		type: shape.type,
		parentId: shape.parentId,
		index: shape.index,
		x: shape.x,
		y: shape.y,
		rotation: shape.rotation ?? 0,
		w: shape.props?.w ?? null,
		h: shape.props?.h ?? null,
		label: plainText(shape.props?.richText),
		color: shape.props?.color ?? null,
		labelColor: shape.props?.labelColor ?? null,
	}
}

function bindingSummary(binding) {
	return {
		id: binding.id,
		type: binding.type,
		fromId: binding.fromId,
		toId: binding.toId,
		props: binding.props,
	}
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

function pageProjection(targetPageId, detail = 'summary') {
	const page = pageRecordById(targetPageId)
	const { shapes, bindings } = pageShapesAndBindings(targetPageId)
	return {
		page: { id: page.id, name: page.name, index: page.index },
		shapeCount: shapes.length,
		bindingCount: bindings.length,
		shapes: detail === 'records' ? shapes : shapes.map(shapeSummary),
		bindings: detail === 'records' ? bindings : bindings.map(bindingSummary),
		topology: topologyForPage(targetPageId),
	}
}

function pruneViewClients(now = Date.now()) {
	for (const [clientId, view] of viewClients) {
		if (now - view.updatedAt > VIEW_CLIENT_RETENTION_MS) viewClients.delete(clientId)
	}
}

function currentViewClient() {
	const now = Date.now()
	pruneViewClients(now)
	const live = [...viewClients.values()].filter((view) => {
		const age = now - view.updatedAt
		return age <= (view.active ? VIEW_ACTIVE_TTL_MS : VIEW_BACKGROUND_TTL_MS)
	})
	if (!live.length) return null
	live.sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1
		return b.updatedAt - a.updatedAt
	})
	return live[0]
}

function finiteNumber(value, name) {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
	return value
}

function normalizeBox(value, name) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is required`)
	return {
		x: finiteNumber(value.x, `${name}.x`),
		y: finiteNumber(value.y, `${name}.y`),
		w: finiteNumber(value.w, `${name}.w`),
		h: finiteNumber(value.h, `${name}.h`),
	}
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) return []
	return [...new Set(value.filter((item) => typeof item === 'string' && item))]
}

function normalizeSnapshot(value) {
	if (value === undefined) return undefined
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('snapshot must be an object')
	if (value.mimeType !== 'image/png') throw new Error('snapshot.mimeType must be image/png')
	if (typeof value.data !== 'string' || !value.data) throw new Error('snapshot.data is required')
	if (value.data.length > 12 * 1024 * 1024) throw new Error('snapshot.data is too large')
	const width = finiteNumber(value.width, 'snapshot.width')
	const height = finiteNumber(value.height, 'snapshot.height')
	if (width <= 0 || height <= 0 || width > 10000 || height > 10000) throw new Error('snapshot dimensions are invalid')
	return { mimeType: value.mimeType, data: value.data, width, height }
}

function normalizeViewPayload(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('View payload is required')
	if (typeof body.clientId !== 'string' || !body.clientId) throw new Error('clientId is required')
	if (!Number.isInteger(body.viewToken) || body.viewToken < 0) throw new Error('viewToken must be a non-negative integer')
	if (typeof body.pageId !== 'string' || !body.pageId) throw new Error('pageId is required')
	const page = pageRecordById(body.pageId)
	if (!body.camera || typeof body.camera !== 'object' || Array.isArray(body.camera)) throw new Error('camera is required')
	const snapshot = normalizeSnapshot(body.snapshot)
	return {
		clientId: body.clientId,
		viewToken: body.viewToken,
		active: body.active === true,
		pageId: page.id,
		pageName: typeof body.pageName === 'string' && body.pageName ? body.pageName : page.name,
		camera: {
			x: finiteNumber(body.camera.x, 'camera.x'),
			y: finiteNumber(body.camera.y, 'camera.y'),
			z: finiteNumber(body.camera.z, 'camera.z'),
		},
		viewport: {
			pageBounds: normalizeBox(body.viewport?.pageBounds, 'viewport.pageBounds'),
			screenBounds: normalizeBox(body.viewport?.screenBounds, 'viewport.screenBounds'),
		},
		selectedShapeIds: normalizeStringArray(body.selectedShapeIds),
		visibleShapeIds: normalizeStringArray(body.visibleShapeIds),
		snapshot,
		snapshotError: typeof body.snapshotError === 'string' ? body.snapshotError : undefined,
	}
}

function updateViewClient(body) {
	const next = normalizeViewPayload(body)
	const now = Date.now()
	const previous = viewClients.get(next.clientId)
	const sameViewToken = previous?.viewToken === next.viewToken
	const snapshot = next.snapshot ?? (sameViewToken ? previous?.snapshot ?? null : null)
	const snapshotCapturedAt = next.snapshot
		? now
		: sameViewToken
			? previous?.snapshotCapturedAt ?? null
			: null
	const stored = {
		...next,
		snapshot,
		snapshotViewToken: next.snapshot ? next.viewToken : (sameViewToken ? previous?.snapshotViewToken ?? null : null),
		snapshotCapturedAt,
		updatedAt: now,
	}
	viewClients.set(stored.clientId, stored)
	pruneViewClients(now)
	return {
		ok: true,
		clientId: stored.clientId,
		pageId: stored.pageId,
		viewToken: stored.viewToken,
		updatedAt: stored.updatedAt,
		snapshotAvailable: !!stored.snapshot && stored.snapshotViewToken === stored.viewToken,
	}
}

function removeViewClient(clientId) {
	if (typeof clientId !== 'string' || !clientId) return false
	return viewClients.delete(clientId)
}

function viewClientPublic(view, { includeSnapshot = false } = {}) {
	if (!view) return null
	const result = {
		clientId: view.clientId,
		viewToken: view.viewToken,
		active: view.active,
		pageId: view.pageId,
		pageName: view.pageName,
		camera: view.camera,
		viewport: view.viewport,
		selectedShapeIds: view.selectedShapeIds,
		visibleShapeIds: view.visibleShapeIds,
		updatedAt: view.updatedAt,
		ageMs: Math.max(0, Date.now() - view.updatedAt),
		snapshotAvailable: !!view.snapshot && view.snapshotViewToken === view.viewToken,
		snapshotViewToken: view.snapshotViewToken,
		snapshotCapturedAt: view.snapshotCapturedAt,
		snapshotError: view.snapshotError ?? null,
	}
	if (includeSnapshot) result.snapshot = view.snapshot
	return result
}

function pageListView() {
	const current = currentViewClient()
	const counts = new Map()
	for (const page of pageRecords()) counts.set(page.id, pageShapesAndBindings(page.id).shapes.length)
	return {
		revision,
		currentPageId: current?.pageId ?? null,
		viewAvailable: !!current,
		pages: pageRecords().map((page) => ({
			id: page.id,
			name: page.name,
			index: page.index,
			shapeCount: counts.get(page.id) ?? 0,
			isCurrent: page.id === current?.pageId,
		})),
		url: CANVAS_URL,
	}
}

function resolvePageId(requestedPageId) {
	if (typeof requestedPageId === 'string' && requestedPageId) {
		pageRecordById(requestedPageId)
		return requestedPageId
	}
	const current = currentViewClient()
	if (!current) throw new Error('Current tldraw browser page is unavailable; open the canvas or provide page_id explicitly')
	return current.pageId
}

function viewGet() {
	const view = currentViewClient()
	if (!view) return { available: false, revision, url: CANVAS_URL }
	const projection = pageProjection(view.pageId, 'summary')
	const visibleIds = new Set(view.visibleShapeIds)
	const selectedIds = new Set(view.selectedShapeIds)
	return {
		available: true,
		revision,
		url: CANVAS_URL,
		view: viewClientPublic(view),
		visibleShapes: projection.shapes.filter((shape) => visibleIds.has(shape.id)),
		selectedShapes: projection.shapes.filter((shape) => selectedIds.has(shape.id)),
		visibleTopology: {
			nodes: projection.topology.nodes.filter((node) => visibleIds.has(node.id)),
			edges: projection.topology.edges.filter((edge) => visibleIds.has(edge.id)),
		},
	}
}

function viewSnapshot() {
	const view = currentViewClient()
	if (!view) throw new Error('Current tldraw browser view is unavailable')
	if (!view.snapshot || view.snapshotViewToken !== view.viewToken) {
		const detail = view.snapshotError ? `: ${view.snapshotError}` : ''
		throw new Error(`Current tldraw browser snapshot is unavailable for the latest view${detail}`)
	}
	return {
		mimeType: view.snapshot.mimeType,
		data: view.snapshot.data,
		width: view.snapshot.width,
		height: view.snapshot.height,
		pageId: view.pageId,
		pageName: view.pageName,
		clientId: view.clientId,
		viewToken: view.viewToken,
		capturedAt: view.snapshotCapturedAt,
		ageMs: Math.max(0, Date.now() - view.snapshotCapturedAt),
		viewport: view.viewport,
		selectedShapeIds: view.selectedShapeIds,
	}
}

function documentTopologyView() {
	const records = store.allRecords()
	const shapes = records.filter((r) => r.typeName === 'shape')
	const nodes = shapes.filter((s) => s.type === 'geo').map((s) => ({
		id: s.id,
		pageId: pageIdForShape(s),
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
			pageId: pageIdForShape(s),
			from: start?.toId ?? null,
			to: end?.toId ?? null,
			label: plainText(s.props?.richText),
		}
	})
	return {
		revision,
		scope: 'document',
		pages: pageRecords().map((page) => ({ id: page.id, name: page.name, index: page.index })),
		nodes,
		edges,
		url: CANVAS_URL,
	}
}

function topologyView(args = {}) {
	if (args.scope === 'document') {
		if (args.page_id !== undefined) throw new Error('page_id cannot be combined with scope=document')
		return documentTopologyView()
	}
	const targetPageId = resolvePageId(args.page_id)
	const page = pageRecordById(targetPageId)
	return {
		revision,
		scope: 'page',
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

async function addEdge({ from, to, page_id, label = '' }) {
	const fromNode = shapeById(from)
	const toNode = shapeById(to)
	if (fromNode.type !== 'geo' || toNode.type !== 'geo') throw new Error('Edges must connect topology nodes')
	const fromPageId = pageIdForShape(fromNode)
	const toPageId = pageIdForShape(toNode)
	if (fromPageId !== toPageId) throw new Error(`Cross-page topology edges are not allowed: ${fromPageId} -> ${toPageId}`)
	if (page_id !== undefined) {
		const requestedPageId = resolvePageId(page_id)
		if (requestedPageId !== fromPageId) {
			throw new Error(`page_id does not own both endpoint nodes: requested ${requestedPageId}, endpoints ${fromPageId}`)
		}
	}
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

async function clearTopology({ page_id, scope = 'current_page' } = {}) {
	if (scope === 'document') {
		if (page_id !== undefined) throw new Error('page_id cannot be combined with scope=document')
		const removed = store.allRecords()
			.filter((r) => r.typeName === 'shape' || r.typeName === 'binding')
			.map((r) => r.id)
		if (removed.length) await commitUnsafe({ removed })
		return { scope: 'document', removed: removed.length, revision }
	}
	const targetPageId = resolvePageId(page_id)
	const { shapes, bindings } = pageShapesAndBindings(targetPageId)
	const removed = [...new Set([...shapes.map((r) => r.id), ...bindings.map((r) => r.id)])]
	if (removed.length) await commitUnsafe({ removed })
	return { scope: 'page', pageId: targetPageId, removed: removed.length, revision }
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
	if (name === 'page_get') {
		await mutationTail
		const detail = args.detail === 'records' ? 'records' : 'summary'
		const targetPageId = resolvePageId(args.page_id)
		return { revision, url: CANVAS_URL, ...pageProjection(targetPageId, detail) }
	}
	if (name === 'view_get') {
		await mutationTail
		return viewGet()
	}
	if (name === 'view_snapshot') {
		await mutationTail
		return viewSnapshot()
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
		if (req.method === 'GET' && url.pathname === '/api/view') {
			const view = currentViewClient()
			return json(res, 200, {
				revision,
				available: !!view,
				view: viewClientPublic(view),
				url: CANVAS_URL,
			})
		}
		if (req.method === 'POST' && url.pathname === '/api/view') {
			const body = await readJson(req)
			return json(res, 200, updateViewClient(body))
		}
		if (req.method === 'DELETE' && url.pathname === '/api/view') {
			const clientId = url.searchParams.get('clientId')
			if (!clientId) return json(res, 400, { error: 'clientId is required' })
			return json(res, 200, { ok: true, removed: removeViewClient(clientId) })
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