import { react, type Editor, type TLShapeId } from 'tldraw'

interface ViewSnapshot {
	mimeType: string
	data: string
	width: number
	height: number
}

interface ViewPayload {
	clientId: string
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

function visualStateKey(editor: Editor) {
	const camera = editor.getCamera()
	return JSON.stringify({
		pageId: editor.getCurrentPageId(),
		camera: { x: camera.x, y: camera.y, z: camera.z },
		pageBounds: boxJson(editor.getViewportPageBounds()),
		screenBounds: boxJson(editor.getViewportScreenBounds()),
		selectedShapeIds: editor.getSelectedShapeIds(),
		shapes: editor.getCurrentPageShapesSorted().map((shape) => ({
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
	clientId: string,
	viewToken: number,
): Omit<ViewPayload, 'snapshot' | 'snapshotError'> {
	const page = editor.getCurrentPage()
	const pageBounds = editor.getViewportPageBounds()
	const screenBounds = editor.getViewportScreenBounds()
	const camera = editor.getCamera()
	const visible = editor.getShapeIdsInsideBounds(pageBounds)
	const visibleShapeIds = editor
		.getCurrentPageShapesSorted()
		.filter((shape) => visible.has(shape.id))
		.map((shape) => shape.id)

	return {
		clientId,
		viewToken,
		active: document.visibilityState === 'visible',
		pageId: page.id,
		pageName: page.name,
		camera: { x: camera.x, y: camera.y, z: camera.z },
		viewport: {
			pageBounds: boxJson(pageBounds),
			screenBounds: boxJson(screenBounds),
		},
		selectedShapeIds: editor.getSelectedShapeIds(),
		visibleShapeIds,
	}
}

async function renderViewportSnapshot(editor: Editor): Promise<ViewSnapshot> {
	const bounds = editor.getViewportPageBounds()
	const shapeIds = [...editor.getCurrentPageShapeIds()] as TLShapeId[]
	const result = await editor.toImageDataUrl(shapeIds, {
		format: 'png',
		bounds,
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

function closeView(clientId: string) {
	void fetch(`/api/view?clientId=${encodeURIComponent(clientId)}`, {
		method: 'DELETE',
		keepalive: true,
	}).catch(() => {
		// Best effort only: retention TTL remains the fallback if the page disappears abruptly.
	})
}

export function startViewBridge(editor: Editor) {
	const clientId = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
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
			const current = readView(editor, clientId, viewToken)
			if (viewKey(current) !== viewKey(base)) {
				// The export belongs to an old page/camera. Never let a slow snapshot roll
				// the daemon's current browser view backward.
				pendingSnapshot = true
				return
			}
			await postView({ ...current, snapshot })
		} catch (error) {
			if (stopped) return
			const current = readView(editor, clientId, viewToken)
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
		pendingSnapshot ||= includeSnapshot
		// Throttle rather than debounce. Continuous editor reactions must never be able to
		// postpone publication forever; the first trigger owns the current timer.
		if (publishTimer !== undefined) return
		publishTimer = window.setTimeout(() => {
			publishTimer = undefined
			const shouldSnapshot = pendingSnapshot
			pendingSnapshot = false
			publishTail = publishTail
				.then(async () => {
					if (stopped) return
					const base = readView(editor, clientId, viewToken)
					// Publish lightweight metadata first. A slow image export must never
					// starve the page/camera heartbeat or make the view appear offline.
					await postView(base)
					if (shouldSnapshot) void publishSnapshot(base)
				})
				.catch((error) => {
					console.error('tldraw MCP view bridge error', error)
				})
		}, includeSnapshot ? 350 : 0)
	}

	const stopReaction = react('tldraw MCP view bridge', () => {
		// Derive the token from actual visual/document state, not from reaction rerun count.
		// Exporting an image may touch internal reactive state; that must not invalidate
		// the snapshot unless the page/camera/selection/rendered shape state truly changed.
		const nextVisualStateKey = visualStateKey(editor)
		if (nextVisualStateKey !== lastVisualStateKey) {
			lastVisualStateKey = nextVisualStateKey
			viewToken += 1
		}
		queuePublish(true)
	})

	const onFocusChange = () => queuePublish(false)
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
		closeView(clientId)
	}
}
