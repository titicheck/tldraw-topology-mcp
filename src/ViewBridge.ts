import { react, type Editor, type TLShapeId } from 'tldraw'

interface ViewSnapshot {
	mimeType: string
	data: string
	width: number
	height: number
}

interface ViewPayload {
	viewId: string
	viewToken: number
	active: boolean
	pageId: string
	pageName: string
	camera: { x: number; y: number; z: number }
	viewport: {
		pageBounds: { x: number; y: number; w: number; h: number }
		screenBounds: { x: number; y: number; w: number; h: number }
	}
	selectedShapeIds: string[]
	visibleShapeIds: string[]
	snapshot?: ViewSnapshot
	snapshotError?: string
}

function boxJson(box: { x: number; y: number; w: number; h: number }) {
	return { x: box.x, y: box.y, w: box.w, h: box.h }
}

function parseDataUrl(url: string, width: number, height: number): ViewSnapshot {
	const match = /^data:([^;,]+);base64,(.+)$/.exec(url)
	if (!match) throw new Error('Unexpected image data URL returned by tldraw')
	return { mimeType: match[1], data: match[2], width, height }
}

function visibleShapeIds(editor: Editor) {
	const bounds = editor.getViewportPageBounds()
	const inside = editor.getShapeIdsInsideBounds(bounds)
	return editor
		.getCurrentPageShapesSorted()
		.filter((shape) => inside.has(shape.id))
		.map((shape) => shape.id)
}

function visualStateKey(editor: Editor) {
	const camera = editor.getCamera()
	const visibleIds = new Set(visibleShapeIds(editor))
	return JSON.stringify({
		pageId: editor.getCurrentPageId(),
		camera: { x: camera.x, y: camera.y, z: camera.z },
		pageBounds: boxJson(editor.getViewportPageBounds()),
		screenBounds: boxJson(editor.getViewportScreenBounds()),
		selectedShapeIds: editor.getSelectedShapeIds(),
		visibleShapes: editor
			.getCurrentPageShapesSorted()
			.filter((shape) => visibleIds.has(shape.id))
			.map((shape) => ({
				id: shape.id,
				parentId: shape.parentId,
				index: shape.index,
				type: shape.type,
				x: shape.x,
				y: shape.y,
				rotation: shape.rotation,
				opacity: shape.opacity,
				props: shape.props,
			})),
	})
}

function readView(
	editor: Editor,
	viewId: string,
	viewToken: number,
): Omit<ViewPayload, 'snapshot' | 'snapshotError'> {
	const page = editor.getCurrentPage()
	const pageBounds = editor.getViewportPageBounds()
	const screenBounds = editor.getViewportScreenBounds()
	const camera = editor.getCamera()

	return {
		viewId,
		viewToken,
		active: document.visibilityState === 'visible' && document.hasFocus(),
		pageId: page.id,
		pageName: page.name,
		camera: { x: camera.x, y: camera.y, z: camera.z },
		viewport: {
			pageBounds: boxJson(pageBounds),
			screenBounds: boxJson(screenBounds),
		},
		selectedShapeIds: editor.getSelectedShapeIds(),
		visibleShapeIds: visibleShapeIds(editor),
	}
}

async function renderViewportSnapshot(editor: Editor): Promise<ViewSnapshot> {
	const bounds = editor.getViewportPageBounds()
	const shapeIds = [...editor.getCurrentPageShapeIds()] as TLShapeId[]
	const result = await editor.toImageDataUrl(shapeIds, {
		format: 'png',
		bounds,
		scale: editor.getCamera().z,
		padding: 0,
		background: true,
		pixelRatio: 1,
	})
	return parseDataUrl(result.url, result.width, result.height)
}

async function postView(payload: ViewPayload) {
	const response = await fetch('/api/view', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
	if (!response.ok) {
		let detail = `HTTP ${response.status}`
		try {
			const body = await response.json()
			if (typeof body?.error === 'string') detail = body.error
		} catch {
			// Keep the HTTP status fallback.
		}
		throw new Error(`View publish failed: ${detail}`)
	}
}

function closeView(viewId: string) {
	void fetch(`/api/view?viewId=${encodeURIComponent(viewId)}`, {
		method: 'DELETE',
		keepalive: true,
	}).catch(() => {
		// Best effort only. Daemon TTL is the fallback if a browser disappears abruptly.
	})
}

export function startViewBridge(editor: Editor) {
	const viewId = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	let stopped = false
	let publishTimer: number | undefined
	let publishTail = Promise.resolve()
	let pendingSnapshot = false
	let snapshotInFlight = false
	let viewToken = 0
	let lastVisualStateKey = ''

	const viewKey = (view: Omit<ViewPayload, 'snapshot' | 'snapshotError'>) =>
		JSON.stringify({
			viewToken: view.viewToken,
			pageId: view.pageId,
			camera: view.camera,
			pageBounds: view.viewport.pageBounds,
			screenBounds: view.viewport.screenBounds,
		})

	const publishSnapshot = async (base: Omit<ViewPayload, 'snapshot' | 'snapshotError'>) => {
		if (snapshotInFlight) {
			pendingSnapshot = true
			return
		}
		snapshotInFlight = true
		try {
			const snapshot = await renderViewportSnapshot(editor)
			if (stopped) return
			const current = readView(editor, viewId, viewToken)
			if (viewKey(current) !== viewKey(base)) {
				pendingSnapshot = true
				return
			}
			await postView({ ...current, snapshot })
		} catch (error) {
			if (stopped) return
			const current = readView(editor, viewId, viewToken)
			if (viewKey(current) === viewKey(base)) {
				const snapshotError = error instanceof Error ? error.message : String(error)
				await postView({ ...current, snapshotError })
			} else {
				pendingSnapshot = true
			}
		} finally {
			snapshotInFlight = false
			if (pendingSnapshot && !stopped) queuePublish(true)
		}
	}

	const queuePublish = (includeSnapshot: boolean) => {
		if (stopped) return
		pendingSnapshot ||= includeSnapshot && document.visibilityState === 'visible'
		if (publishTimer !== undefined) return
		publishTimer = window.setTimeout(() => {
			publishTimer = undefined
			const shouldSnapshot = pendingSnapshot
			pendingSnapshot = false
			publishTail = publishTail
				.then(async () => {
					if (stopped) return
					const base = readView(editor, viewId, viewToken)
					await postView(base)
					if (shouldSnapshot) void publishSnapshot(base)
				})
				.catch((error) => {
					console.error('tldraw MCP view bridge error', error)
				})
		}, includeSnapshot ? 350 : 0)
	}

	const stopReaction = react('tldraw MCP view bridge', () => {
		const nextVisualStateKey = visualStateKey(editor)
		if (nextVisualStateKey !== lastVisualStateKey) {
			lastVisualStateKey = nextVisualStateKey
			viewToken += 1
		}
		queuePublish(true)
	})

	const onFocusChange = () => queuePublish(document.visibilityState === 'visible')
	const onResize = () => queuePublish(true)
	window.addEventListener('focus', onFocusChange)
	window.addEventListener('blur', onFocusChange)
	window.addEventListener('resize', onResize)
	document.addEventListener('visibilitychange', onFocusChange)

	const heartbeat = window.setInterval(() => queuePublish(false), 3000)
	queuePublish(true)

	return () => {
		stopped = true
		stopReaction()
		window.removeEventListener('focus', onFocusChange)
		window.removeEventListener('blur', onFocusChange)
		window.removeEventListener('resize', onResize)
		document.removeEventListener('visibilitychange', onFocusChange)
		window.clearInterval(heartbeat)
		if (publishTimer !== undefined) window.clearTimeout(publishTimer)
		closeView(viewId)
	}
}
