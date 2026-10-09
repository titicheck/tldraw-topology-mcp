import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const DAEMON_URL = ((process.env.TLDRAW_TOPOLOGY_DAEMON_URL ?? 'http://127.0.0.1:5173').trim() || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const rawTimeout = Number(process.env.TLDRAW_TOPOLOGY_TIMEOUT_MS ?? 10000)
const REQUEST_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10000

const Color = z.enum([
	'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
	'orange', 'green', 'light-green', 'light-red', 'red', 'white',
])
const Geo = z.enum([
	'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
	'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
	'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart',
])
const Dash = z.enum(['draw', 'solid', 'dashed', 'dotted', 'none'])
const Fill = z.enum(['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'])
const Size = z.enum(['s', 'm', 'l', 'xl'])
const Font = z.enum(['draw', 'sans', 'serif', 'mono'])
const HorizontalAlign = z.enum(['start', 'middle', 'end'])
const VerticalAlign = z.enum(['start', 'middle', 'end'])
const ArrowKind = z.enum(['arc', 'elbow'])
const Arrowhead = z.enum(['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none'])
const UnitInterval = z.number().min(0).max(1)
const Positive = z.number().positive()
const ShapeType = z.enum([
	'arrow', 'bookmark', 'draw', 'embed', 'frame', 'geo', 'group',
	'highlight', 'image', 'line', 'note', 'text', 'video',
])
const LooseObject = z.object({}).catchall(z.unknown())

const richTextFields = {
	bold: z.boolean().optional(),
	italic: z.boolean().optional(),
	bulletList: z.boolean().optional(),
	highlight: z.boolean().optional(),
}

const geoStyleFields = {
	geo: Geo.optional(),
	color: Color.optional(),
	labelColor: Color.optional(),
	fill: Fill.optional(),
	dash: Dash.optional(),
	size: Size.optional(),
	font: Font.optional(),
	align: HorizontalAlign.optional(),
	verticalAlign: VerticalAlign.optional(),
	opacity: UnitInterval.optional(),
	rotation: z.number().optional(),
	scale: Positive.optional(),
	flipX: z.boolean().optional(),
	flipY: z.boolean().optional(),
	url: z.string().optional(),
	...richTextFields,
}

const arrowStyleFields = {
	kind: ArrowKind.optional(),
	color: Color.optional(),
	labelColor: Color.optional(),
	fill: Fill.optional(),
	dash: Dash.optional(),
	size: Size.optional(),
	font: Font.optional(),
	arrowheadStart: Arrowhead.optional(),
	arrowheadEnd: Arrowhead.optional(),
	bend: z.number().optional(),
	labelPosition: UnitInterval.optional(),
	elbowMidPoint: UnitInterval.optional(),
	opacity: UnitInterval.optional(),
	rotation: z.number().optional(),
	scale: Positive.optional(),
	...richTextFields,
}

async function callDaemon(name, args = {}) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(`${DAEMON_URL}/api/topology/command`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name, arguments: args }),
			signal: controller.signal,
		})
		const text = await response.text()
		let payload
		try {
			payload = text ? JSON.parse(text) : {}
		} catch {
			payload = { error: text || `HTTP ${response.status}` }
		}
		if (!response.ok) throw new Error(payload.error || `tldraw daemon HTTP ${response.status}`)
		return payload.result
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`tldraw daemon request timed out after ${REQUEST_TIMEOUT_MS}ms: ${DAEMON_URL}`)
		}
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(`tldraw daemon request failed at ${DAEMON_URL}: ${detail}`)
	} finally {
		clearTimeout(timer)
	}
}

const mcp = new McpServer({ name: 'tldraw-topology', version: '0.1.0' })
const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

mcp.registerTool('page_list', {
	description: 'List tldraw document pages with stable page IDs, names, order, and topology node/edge counts.',
	inputSchema: {},
}, async () => textResult(await callDaemon('page_list')))

mcp.registerTool('topology_get', {
	description: 'Read one tldraw page topology including full editable Geo and Arrow presentation properties.',
	inputSchema: {
		page_id: z.string().min(1),
	},
}, async (args) => textResult(await callDaemon('topology_get', args)))


mcp.registerTool('shape_list', {
	description: 'List shapes contained in exactly one tldraw Page. Returns compact shape summaries; use shape_get for the complete native record.',
	inputSchema: {
		page_id: z.string().min(1),
		types: z.array(ShapeType).optional(),
	},
}, async (args) => textResult(await callDaemon('shape_list', args)))

mcp.registerTool('shape_get', {
	description: 'Read one complete native tldraw shape record and its owning Page.',
	inputSchema: {
		id: z.string().min(1),
	},
}, async (args) => textResult(await callDaemon('shape_get', args)))

mcp.registerTool('shape_add', {
	description: 'Create any built-in tldraw shape on one explicit Page using native shape props. Defaults match tldraw built-ins; props may override them.',
	inputSchema: {
		page_id: z.string().min(1),
		type: ShapeType,
		parent_id: z.string().min(1).optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		rotation: z.number().optional(),
		opacity: UnitInterval.optional(),
		is_locked: z.boolean().optional(),
		props: LooseObject.optional(),
		meta: LooseObject.optional(),
		text: z.string().optional(),
		...richTextFields,
	},
}, async (args) => textResult(await callDaemon('shape_add', args)))

mcp.registerTool('shape_update', {
	description: 'Patch any existing tldraw shape using its native props while preserving its type and Page ownership.',
	inputSchema: {
		id: z.string().min(1),
		x: z.number().optional(),
		y: z.number().optional(),
		rotation: z.number().optional(),
		opacity: UnitInterval.optional(),
		is_locked: z.boolean().optional(),
		props: LooseObject.optional(),
		meta: LooseObject.optional(),
		text: z.string().optional(),
		...richTextFields,
	},
}, async (args) => textResult(await callDaemon('shape_update', args)))

mcp.registerTool('shape_delete', {
	description: 'Delete any tldraw shape. Container descendants and bindings to deleted shapes are removed atomically within the owning Page.',
	inputSchema: {
		id: z.string().min(1),
	},
}, async (args) => textResult(await callDaemon('shape_delete', args)))

mcp.registerTool('node_add', {
	description: 'Add a Geo topology node with optional full tldraw presentation styles.',
	inputSchema: {
		label: z.string().min(1),
		page_id: z.string().min(1),
		x: z.number().optional(),
		y: z.number().optional(),
		w: Positive.optional(),
		h: Positive.optional(),
		...geoStyleFields,
	},
}, async (args) => textResult(await callDaemon('node_add', args)))

mcp.registerTool('node_update', {
	description: 'Update a Geo topology node geometry, shape, colors, fill, stroke, font, alignment, opacity, scale, flips, URL, or whole-label rich-text formatting.',
	inputSchema: {
		id: z.string().min(1),
		label: z.string().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		w: Positive.optional(),
		h: Positive.optional(),
		...geoStyleFields,
	},
}, async (args) => textResult(await callDaemon('node_update', args)))

mcp.registerTool('node_delete', {
	description: 'Delete a topology node and any directed edges connected to it.',
	inputSchema: { id: z.string().min(1) },
}, async (args) => textResult(await callDaemon('node_delete', args)))

mcp.registerTool('edge_add', {
	description: 'Add a directed Arrow between two nodes with optional full tldraw arrow and label styles.',
	inputSchema: {
		from: z.string().min(1),
		to: z.string().min(1),
		label: z.string().optional(),
		...arrowStyleFields,
	},
}, async (args) => textResult(await callDaemon('edge_add', args)))

mcp.registerTool('edge_update', {
	description: 'Update an Arrow label, kind, colors, fill, dash, size, font, arrowheads, bend, label position, opacity, scale, elbow midpoint, rotation, or whole-label rich-text formatting.',
	inputSchema: {
		id: z.string().min(1),
		label: z.string().optional(),
		...arrowStyleFields,
	},
}, async (args) => textResult(await callDaemon('edge_update', args)))

mcp.registerTool('edge_delete', {
	description: 'Delete a directed topology edge and its tldraw bindings.',
	inputSchema: { id: z.string().min(1) },
}, async (args) => textResult(await callDaemon('edge_delete', args)))

mcp.registerTool('topology_clear', {
	description: 'Delete topology content from exactly one tldraw page while keeping the page itself, non-topology containers, and every other page unchanged.',
	inputSchema: {
		page_id: z.string().min(1),
	},
}, async (args) => textResult(await callDaemon('topology_clear', args)))

async function main() {
	const transport = new StdioServerTransport()
	await mcp.connect(transport)
	console.error(`tldraw-topology MCP adapter connected to ${DAEMON_URL}`)
}

main().catch((error) => {
	console.error('tldraw-topology MCP adapter fatal:', error)
	process.exit(1)
})
