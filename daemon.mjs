import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Editor as TipTapEditor } from '@tiptap/core'
import {
	createTLStore,
	createShapeId,
	createBindingId,
	toRichText,
	DocumentRecordType,
	PageRecordType,
	TLDOCUMENT_ID,
	getIndexAbove,
	getTipTapDefaultExtensions,
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

const COLOR_VALUES = new Set([
	'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
	'orange', 'green', 'light-green', 'light-red', 'red', 'white',
])
const GEO_VALUES = new Set([
	'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
	'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
	'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart',
])
const DASH_VALUES = new Set(['draw', 'solid', 'dashed', 'dotted', 'none'])
const FILL_VALUES = new Set(['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'])
const SIZE_VALUES = new Set(['s', 'm', 'l', 'xl'])
const FONT_VALUES = new Set(['draw', 'sans', 'serif', 'mono'])
const H_ALIGN_VALUES = new Set(['start', 'middle', 'end'])
const V_ALIGN_VALUES = new Set(['start', 'middle', 'end'])
const ARROW_KIND_VALUES = new Set(['arc', 'elbow'])
const ARROWHEAD_VALUES = new Set([
	'arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none',
])

const DEFAULT_SHAPE_TYPES = new Set([
	'arrow', 'bookmark', 'draw', 'embed', 'frame', 'geo', 'group',
	'highlight', 'image', 'line', 'note', 'text', 'video',
])

function defaultPropsForShape(type) {
	switch (type) {
		case 'geo':
			return { ...GEO_DEFAULTS, w: 100, h: 100 }
		case 'arrow':
			return structuredClone(ARROW_DEFAULTS)
		case 'text':
			return {
				color: 'black',
				size: 'm',
				w: 8,
				font: 'draw',
				textAlign: 'start',
				autoSize: true,
				scale: 1,
				richText: toRichText(''),
			}
		case 'note':
			return {
				color: 'black',
				richText: toRichText(''),
				size: 'm',
				font: 'draw',
				align: 'middle',
				verticalAlign: 'middle',
				labelColor: 'black',
				growY: 0,
				fontSizeAdjustment: 1,
				url: '',
				scale: 1,
				textLastEditedBy: null,
			}
		case 'frame':
			return { w: 320, h: 180, name: '', color: 'black' }
		case 'group':
			return {}
		case 'draw':
			return {
				segments: [],
				color: 'black',
				fill: 'none',
				dash: 'draw',
				size: 'm',
				isComplete: false,
				isClosed: false,
				isPen: false,
				scale: 1,
				scaleX: 1,
				scaleY: 1,
			}
		case 'highlight':
			return {
				segments: [],
				color: 'black',
				size: 'm',
				isComplete: false,
				isPen: false,
				scale: 1,
				scaleX: 1,
				scaleY: 1,
			}
		case 'line': {
			const start = 'a1'
			const end = getIndexAbove(start)
			return {
				dash: 'draw',
				size: 'm',
				color: 'black',
				spline: 'line',
				points: {
					[start]: { id: start, index: start, x: 0, y: 0 },
					[end]: { id: end, index: end, x: 0.1, y: 0.1 },
				},
				scale: 1,
			}
		}
		case 'image':
			return {
				w: 100,
				h: 100,
				assetId: null,
				playing: true,
				url: '',
				crop: null,
				flipX: false,
				flipY: false,
				altText: '',
			}
		case 'video':
			return {
				w: 100,
				h: 100,
				assetId: null,
				autoplay: true,
				url: '',
				altText: '',
				time: 0,
				playing: true,
			}
		case 'bookmark':
			return { url: '', w: 300, h: 320, assetId: null }
		case 'embed':
			return { w: 300, h: 300, url: '' }
		default:
			throw new Error(`Unsupported shape type: ${type}`)
	}
}

function richTextArgsForGeneric(args) {
	return {
		label: args.text,
		bold: args.bold,
		italic: args.italic,
		bulletList: args.bulletList,
		highlight: args.highlight,
	}
}

function enumValue(name, value, allowed) {
	if (value === undefined) return undefined
	if (!allowed.has(value)) throw new Error(`Invalid ${name}: ${value}`)
	return value
}

function finiteNumber(name, value) {
	if (value === undefined) return undefined
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
	return value
}

function unitInterval(name, value) {
	const number = finiteNumber(name, value)
	if (number === undefined) return undefined
	if (number < 0 || number > 1) throw new Error(`${name} must be between 0 and 1`)
	return number
}

function positiveNumber(name, value) {
	const number = finiteNumber(name, value)
	if (number === undefined) return undefined
	if (number <= 0) throw new Error(`${name} must be greater than 0`)
	return number
}

function richTextEditRequested(args) {
	return args.label !== undefined
		|| args.bold !== undefined
		|| args.italic !== undefined
		|| args.bulletList !== undefined
		|| args.highlight !== undefined
}

function transformRichText(baseRichText, args) {
	let richText = args.label === undefined ? baseRichText : toRichText(args.label)
	if (!richTextEditRequested({ ...args, label: undefined })) return richText

	const editor = new TipTapEditor({
		extensions: getTipTapDefaultExtensions(),
		enableCoreExtensions: { textDirection: false },
		textDirection: 'auto',
		content: richText,
	})

	try {
		editor.commands.selectAll()
		if (args.bold !== undefined) {
			args.bold ? editor.commands.setBold() : editor.commands.unsetBold()
		}
		if (args.italic !== undefined) {
			args.italic ? editor.commands.setItalic() : editor.commands.unsetItalic()
		}
		if (args.highlight !== undefined) {
			args.highlight ? editor.commands.setHighlight() : editor.commands.unsetHighlight()
		}
		if (args.bulletList !== undefined) {
			const active = editor.isActive('bulletList')
			if (active !== args.bulletList) editor.commands.toggleBulletList()
		}
		return editor.getJSON()
	} finally {
		editor.destroy()
	}
}

function markState(richText, markName) {
	let total = 0
	let marked = 0
	const visit = (node) => {
		if (!node || typeof node !== 'object') return
		if (node.type === 'text' && typeof node.text === 'string' && node.text.length > 0) {
			total += 1
			if (node.marks?.some((mark) => mark.type === markName)) marked += 1
		}
		if (Array.isArray(node.content)) node.content.forEach(visit)
	}
	visit(richText)
	if (total === 0 || marked === 0) return false
	if (marked === total) return true
	return 'mixed'
}

function bulletListState(richText) {
	const content = Array.isArray(richText?.content) ? richText.content : []
	const meaningful = content.filter((node) => {
		let found = false
		const visit = (item) => {
			if (!item || typeof item !== 'object' || found) return
			if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
				found = true
				return
			}
			if (Array.isArray(item.content)) item.content.forEach(visit)
		}
		visit(node)
		return found
	})
	if (meaningful.length === 0) return false
	const listed = meaningful.filter((node) => node.type === 'bulletList').length
	if (listed === 0) return false
	if (listed === meaningful.length) return true
	return 'mixed'
}

function textFormatSummary(richText) {
	return {
		bold: markState(richText, 'bold'),
		italic: markState(richText, 'italic'),
		bulletList: bulletListState(richText),
		highlight: markState(richText, 'highlight'),
	}
}

function geoPropsPatch(args, currentRichText) {
	const patch = {}
	for (const [key, value] of [
		['geo', enumValue('geo', args.geo, GEO_VALUES)],
		['color', enumValue('color', args.color, COLOR_VALUES)],
		['labelColor', enumValue('labelColor', args.labelColor, COLOR_VALUES)],
		['fill', enumValue('fill', args.fill, FILL_VALUES)],
		['dash', enumValue('dash', args.dash, DASH_VALUES)],
		['size', enumValue('size', args.size, SIZE_VALUES)],
		['font', enumValue('font', args.font, FONT_VALUES)],
		['align', enumValue('align', args.align, H_ALIGN_VALUES)],
		['verticalAlign', enumValue('verticalAlign', args.verticalAlign, V_ALIGN_VALUES)],
	]) {
		if (value !== undefined) patch[key] = value
	}
	if (args.url !== undefined) patch.url = String(args.url)
	if (args.flipX !== undefined) patch.flipX = !!args.flipX
	if (args.flipY !== undefined) patch.flipY = !!args.flipY
	const scale = positiveNumber('scale', args.scale)
	if (scale !== undefined) patch.scale = scale
	if (richTextEditRequested(args)) patch.richText = transformRichText(currentRichText, args)
	return patch
}

function arrowPropsPatch(args, currentRichText) {
	const patch = {}
	for (const [key, value] of [
		['kind', enumValue('kind', args.kind, ARROW_KIND_VALUES)],
		['color', enumValue('color', args.color, COLOR_VALUES)],
		['labelColor', enumValue('labelColor', args.labelColor, COLOR_VALUES)],
		['fill', enumValue('fill', args.fill, FILL_VALUES)],
		['dash', enumValue('dash', args.dash, DASH_VALUES)],
		['size', enumValue('size', args.size, SIZE_VALUES)],
		['font', enumValue('font', args.font, FONT_VALUES)],
		['arrowheadStart', enumValue('arrowheadStart', args.arrowheadStart, ARROWHEAD_VALUES)],
		['arrowheadEnd', enumValue('arrowheadEnd', args.arrowheadEnd, ARROWHEAD_VALUES)],
	]) {
		if (value !== undefined) patch[key] = value
	}
	const bend = finiteNumber('bend', args.bend)
	if (bend !== undefined) patch.bend = bend
	const labelPosition = unitInterval('labelPosition', args.labelPosition)
	if (labelPosition !== undefined) patch.labelPosition = labelPosition
	const elbowMidPoint = unitInterval('elbowMidPoint', args.elbowMidPoint)
	if (elbowMidPoint !== undefined) patch.elbowMidPoint = elbowMidPoint
	const scale = positiveNumber('scale', args.scale)
	if (scale !== undefined) patch.scale = scale
	if (richTextEditRequested(args)) patch.richText = transformRichText(currentRichText, args)
	return patch
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

function nextIndexForParent(parentId) {
	const siblings = store.allRecords().filter(
		(record) => record.typeName === 'shape' && record.parentId === parentId,
	)
	if (!siblings.length) return 'a1'
	const last = siblings.map((shape) => shape.index).sort().at(-1)
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
		rotation: s.rotation ?? 0,
		opacity: s.opacity ?? 1,
		geo: s.props?.geo ?? 'rectangle',
		color: s.props?.color ?? 'black',
		labelColor: s.props?.labelColor ?? 'black',
		fill: s.props?.fill ?? 'none',
		dash: s.props?.dash ?? 'draw',
		size: s.props?.size ?? 'm',
		font: s.props?.font ?? 'draw',
		align: s.props?.align ?? 'middle',
		verticalAlign: s.props?.verticalAlign ?? 'middle',
		scale: s.props?.scale ?? 1,
		flipX: s.props?.flipX ?? false,
		flipY: s.props?.flipY ?? false,
		url: s.props?.url ?? '',
		textFormat: textFormatSummary(s.props?.richText),
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
			x: s.x,
			y: s.y,
			rotation: s.rotation ?? 0,
			opacity: s.opacity ?? 1,
			kind: s.props?.kind ?? 'arc',
			color: s.props?.color ?? 'black',
			labelColor: s.props?.labelColor ?? 'black',
			fill: s.props?.fill ?? 'none',
			dash: s.props?.dash ?? 'draw',
			size: s.props?.size ?? 'm',
			font: s.props?.font ?? 'draw',
			arrowheadStart: s.props?.arrowheadStart ?? 'none',
			arrowheadEnd: s.props?.arrowheadEnd ?? 'arrow',
			bend: s.props?.bend ?? 0,
			labelPosition: s.props?.labelPosition ?? 0.5,
			scale: s.props?.scale ?? 1,
			elbowMidPoint: s.props?.elbowMidPoint ?? 0.5,
			start: s.props?.start ?? null,
			end: s.props?.end ?? null,
			textFormat: textFormatSummary(s.props?.richText),
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


function resolveShapeParent(targetPageId, requestedParentId) {
	if (requestedParentId === undefined || requestedParentId === null || requestedParentId === '') {
		return targetPageId
	}
	if (requestedParentId.startsWith('page:')) {
		if (requestedParentId !== targetPageId) {
			throw new Error(`Parent page must equal page_id: ${requestedParentId} !== ${targetPageId}`)
		}
		pageRecordById(requestedParentId)
		return requestedParentId
	}
	const parent = shapeById(requestedParentId)
	const parentPageId = pageIdForShape(parent)
	if (parentPageId !== targetPageId) {
		throw new Error(`Parent shape belongs to a different page: ${parentPageId}`)
	}
	return parent.id
}

function shapePreview(shape) {
	const richText = shape.props?.richText
	return {
		id: shape.id,
		type: shape.type,
		pageId: pageIdForShape(shape),
		parentId: shape.parentId,
		index: shape.index,
		x: shape.x,
		y: shape.y,
		rotation: shape.rotation ?? 0,
		opacity: shape.opacity ?? 1,
		isLocked: shape.isLocked ?? false,
		text: richText ? plainText(richText) : undefined,
		name: typeof shape.props?.name === 'string' ? shape.props.name : undefined,
		url: typeof shape.props?.url === 'string' ? shape.props.url : undefined,
	}
}

function shapeListView({ page_id, types }) {
	const targetPageId = resolvePageId(page_id)
	const page = pageRecordById(targetPageId)
	const typeFilter = Array.isArray(types) && types.length ? new Set(types) : null
	const { shapes } = pageShapesAndBindings(targetPageId)
	return {
		revision,
		page: { id: page.id, name: page.name, index: page.index },
		shapes: shapes
			.filter((shape) => !typeFilter || typeFilter.has(shape.type))
			.map(shapePreview),
		url: CANVAS_URL,
	}
}

function shapeGetView({ id }) {
	const shape = shapeById(id)
	const targetPageId = pageIdForShape(shape)
	return {
		revision,
		pageId: targetPageId,
		shape,
		textFormat: shape.props?.richText ? textFormatSummary(shape.props.richText) : null,
		url: CANVAS_URL,
	}
}

function genericRichTextPatch(baseProps, args) {
	const richArgs = richTextArgsForGeneric(args)
	if (!richTextEditRequested(richArgs)) return baseProps
	if (!('richText' in baseProps)) {
		throw new Error('This shape type does not support rich text')
	}
	return {
		...baseProps,
		richText: transformRichText(baseProps.richText, richArgs),
	}
}

async function addShape(args) {
	const {
		page_id,
		type,
		x = 100,
		y = 100,
		rotation = 0,
		opacity = 1,
		is_locked = false,
		parent_id,
		props = {},
		meta = {},
	} = args
	const targetPageId = resolvePageId(page_id)
	if (!DEFAULT_SHAPE_TYPES.has(type)) throw new Error(`Unsupported shape type: ${type}`)
	const parentId = resolveShapeParent(targetPageId, parent_id)
	const baseProps = { ...defaultPropsForShape(type), ...props }
	const finalProps = genericRichTextPatch(baseProps, args)
	const id = createShapeId(`${type}-${randomUUID()}`)
	const record = store.schema.types.shape.create({
		id,
		type,
		parentId,
		index: nextIndexForParent(parentId),
		x: finiteNumber('x', x),
		y: finiteNumber('y', y),
		rotation: finiteNumber('rotation', rotation),
		opacity: unitInterval('opacity', opacity),
		isLocked: !!is_locked,
		props: finalProps,
		meta,
	})
	store.schema.types.shape.validate(record)
	await commitUnsafe({ added: [record] })
	return { id, type, pageId: targetPageId, parentId, revision }
}

async function updateShape(args) {
	const { id, props = {}, meta } = args
	const shape = shapeById(id)
	const targetPageId = pageIdForShape(shape)
	const mergedProps = genericRichTextPatch({ ...shape.props, ...props }, args)
	const next = {
		...shape,
		...(args.x === undefined ? {} : { x: finiteNumber('x', args.x) }),
		...(args.y === undefined ? {} : { y: finiteNumber('y', args.y) }),
		...(args.rotation === undefined ? {} : { rotation: finiteNumber('rotation', args.rotation) }),
		...(args.opacity === undefined ? {} : { opacity: unitInterval('opacity', args.opacity) }),
		...(args.is_locked === undefined ? {} : { isLocked: !!args.is_locked }),
		...(meta === undefined ? {} : { meta: { ...shape.meta, ...meta } }),
		props: mergedProps,
	}
	store.schema.types.shape.validate(next, shape)
	await commitUnsafe({ updated: [next] })
	return { id: shape.id, type: shape.type, pageId: targetPageId, revision }
}

function descendantShapeIds(rootId) {
	const allShapes = store.allRecords().filter((record) => record.typeName === 'shape')
	const childrenByParent = new Map()
	for (const shape of allShapes) {
		const list = childrenByParent.get(shape.parentId) ?? []
		list.push(shape.id)
		childrenByParent.set(shape.parentId, list)
	}
	const result = new Set([rootId])
	const queue = [rootId]
	while (queue.length) {
		const parentId = queue.shift()
		for (const childId of childrenByParent.get(parentId) ?? []) {
			if (result.has(childId)) continue
			result.add(childId)
			queue.push(childId)
		}
	}
	return result
}

async function deleteShape({ id }) {
	const shape = shapeById(id)
	const targetPageId = pageIdForShape(shape)
	const shapeIds = descendantShapeIds(shape.id)
	const records = store.allRecords()
	const allBindings = records.filter((record) => record.typeName === 'binding')
	const allShapesById = new Map(
		records.filter((record) => record.typeName === 'shape').map((record) => [record.id, record]),
	)

	const connectedArrowIds = new Set()
	for (const binding of allBindings) {
		if (shapeIds.has(binding.toId) && allShapesById.get(binding.fromId)?.type === 'arrow') {
			connectedArrowIds.add(binding.fromId)
		}
	}
	for (const arrowId of connectedArrowIds) shapeIds.add(arrowId)

	const bindingIds = allBindings
		.filter((binding) => shapeIds.has(binding.fromId) || shapeIds.has(binding.toId))
		.map((binding) => binding.id)

	const removed = [...new Set([...shapeIds, ...bindingIds])]
	await commitUnsafe({ removed })
	return {
		id: shape.id,
		type: shape.type,
		pageId: targetPageId,
		removedShapeCount: shapeIds.size,
		removedBindingCount: bindingIds.length,
		revision,
	}
}

async function addNode(args) {
	const {
		label, page_id, x = 100, y = 100, w = 240, h = 100,
		rotation = 0, opacity = 1,
	} = args
	const targetPageId = resolvePageId(page_id)
	const id = createShapeId(`node-${randomUUID()}`)
	const record = store.schema.types.shape.create({
		id,
		type: 'geo',
		parentId: targetPageId,
		index: nextIndex(targetPageId),
		x: finiteNumber('x', x),
		y: finiteNumber('y', y),
		rotation: finiteNumber('rotation', rotation),
		opacity: unitInterval('opacity', opacity),
		props: {
			...GEO_DEFAULTS,
			w: positiveNumber('w', w),
			h: positiveNumber('h', h),
			...geoPropsPatch(args, toRichText(label)),
		},
	})
	await commitUnsafe({ added: [record] })
	return { id, pageId: targetPageId, revision }
}

async function updateNode(args) {
	const { id } = args
	const node = shapeById(id)
	if (node.type !== 'geo') throw new Error(`${node.id} is not a topology node`)
	const targetPageId = pageIdForShape(node)
	const next = {
		...node,
		...(args.x === undefined ? {} : { x: finiteNumber('x', args.x) }),
		...(args.y === undefined ? {} : { y: finiteNumber('y', args.y) }),
		...(args.rotation === undefined ? {} : { rotation: finiteNumber('rotation', args.rotation) }),
		...(args.opacity === undefined ? {} : { opacity: unitInterval('opacity', args.opacity) }),
		props: {
			...node.props,
			...(args.w === undefined ? {} : { w: positiveNumber('w', args.w) }),
			...(args.h === undefined ? {} : { h: positiveNumber('h', args.h) }),
			...geoPropsPatch(args, node.props.richText),
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

async function addEdge(args) {
	const { from, to, label = '', rotation = 0, opacity = 1 } = args
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
		rotation: finiteNumber('rotation', rotation),
		opacity: unitInterval('opacity', opacity),
		props: {
			...ARROW_DEFAULTS,
			end: { x: endX - startX, y: endY - startY },
			...arrowPropsPatch({ ...args, label }, toRichText(label)),
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

async function updateEdge(args) {
	const { id } = args
	const edge = shapeById(id)
	if (edge.type !== 'arrow') throw new Error(`${edge.id} is not a topology edge`)
	const targetPageId = pageIdForShape(edge)
	const next = {
		...edge,
		...(args.rotation === undefined ? {} : { rotation: finiteNumber('rotation', args.rotation) }),
		...(args.opacity === undefined ? {} : { opacity: unitInterval('opacity', args.opacity) }),
		props: {
			...edge.props,
			...arrowPropsPatch(args, edge.props.richText),
		},
	}
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
	if (name === 'shape_list') {
		await mutationTail
		return shapeListView(args)
	}
	if (name === 'shape_get') {
		await mutationTail
		return shapeGetView(args)
	}
	return serializeMutation(async () => {
		switch (name) {
			case 'shape_add': return addShape(args)
			case 'shape_update': return updateShape(args)
			case 'shape_delete': return deleteShape(args)
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