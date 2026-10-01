import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const DAEMON_URL = ((process.env.TLDRAW_TOPOLOGY_DAEMON_URL ?? 'http://127.0.0.1:5173').trim() || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const rawTimeout = Number(process.env.TLDRAW_TOPOLOGY_TIMEOUT_MS ?? 10000)
const REQUEST_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10000

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

mcp.registerTool('topology_get', {
	description: 'Read the current shared Blueprint topology: nodes, directed edges, revision, and local canvas URL.',
	inputSchema: {},
}, async () => textResult(await callDaemon('topology_get')))

mcp.registerTool('node_add', {
	description: 'Add a rectangular topology node to the shared tldraw canvas.',
	inputSchema: {
		label: z.string().min(1), x: z.number().optional(), y: z.number().optional(),
		w: z.number().positive().optional(), h: z.number().positive().optional(),
	},
}, async (args) => textResult(await callDaemon('node_add', args)))

mcp.registerTool('node_update', {
	description: 'Update a topology node label, position, or size.',
	inputSchema: {
		id: z.string().min(1), label: z.string().optional(), x: z.number().optional(), y: z.number().optional(),
		w: z.number().positive().optional(), h: z.number().positive().optional(),
	},
}, async (args) => textResult(await callDaemon('node_update', args)))

mcp.registerTool('node_delete', {
	description: 'Delete a topology node and any directed edges connected to it.',
	inputSchema: { id: z.string().min(1) },
}, async (args) => textResult(await callDaemon('node_delete', args)))

mcp.registerTool('edge_add', {
	description: 'Add a directed arrow between two topology nodes.',
	inputSchema: { from: z.string().min(1), to: z.string().min(1), label: z.string().optional() },
}, async (args) => textResult(await callDaemon('edge_add', args)))

mcp.registerTool('edge_update', {
	description: 'Update the optional label of a directed topology edge.',
	inputSchema: { id: z.string().min(1), label: z.string() },
}, async (args) => textResult(await callDaemon('edge_update', args)))

mcp.registerTool('edge_delete', {
	description: 'Delete a directed topology edge and its tldraw bindings.',
	inputSchema: { id: z.string().min(1) },
}, async (args) => textResult(await callDaemon('edge_delete', args)))

mcp.registerTool('topology_clear', {
	description: 'Delete all topology nodes, arrows, and bindings while keeping the tldraw document and page.',
	inputSchema: {},
}, async () => textResult(await callDaemon('topology_clear')))

async function main() {
	const transport = new StdioServerTransport()
	await mcp.connect(transport)
	console.error(`tldraw-topology MCP adapter connected to ${DAEMON_URL}`)
}

main().catch((error) => {
	console.error('tldraw-topology MCP adapter fatal:', error)
	process.exit(1)
})
