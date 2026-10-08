import { useEffect, useRef, useState } from 'react'
import { createTLStore, Tldraw, type TLComponents, type TLStoreWithStatus } from 'tldraw'
import { CustomStylePanel } from './CustomStylePanel'
import { startViewBridge } from './ViewBridge'

const components = {
	StylePanel: CustomStylePanel,
} satisfies TLComponents

interface ChangeSet {
	added: unknown[]
	updated: unknown[]
	removed: string[]
}

interface SyncEvent extends ChangeSet {
	revision: number
}

function App() {
	const [storeWithStatus, setStoreWithStatus] = useState<TLStoreWithStatus>({ status: 'loading' })
	const revisionRef = useRef(0)
	const queueRef = useRef<Promise<void>>(Promise.resolve())

	useEffect(() => {
		let cancelled = false
		let cleanupStore: (() => void) | undefined
		let pollTimer: number | undefined

		const enqueue = (task: () => Promise<void>) => {
			queueRef.current = queueRef.current.then(task).catch((error) => {
				console.error('tldraw topology sync error', error)
			})
		}

		async function start() {
			try {
				const stateResponse = await fetch('/api/state', { cache: 'no-store' })
				if (!stateResponse.ok) throw new Error(`State load failed: ${stateResponse.status}`)
				const state = await stateResponse.json()
				if (cancelled) return

				const store = createTLStore()
				store.loadStoreSnapshot(state.snapshot)
				revisionRef.current = state.revision

				const applyEvents = (events: SyncEvent[]) => {
					if (!events.length) return
					store.mergeRemoteChanges(() => {
						for (const event of events) {
							const records = [...event.added, ...event.updated] as any[]
							if (records.length) store.put(records)
							const existing = event.removed.filter((id) => store.has(id as any)) as any[]
							if (existing.length) store.remove(existing)
							revisionRef.current = Math.max(revisionRef.current, event.revision)
						}
					})
				}

				const applyServerResponse = (payload: any) => {
					if (payload.reset) {
						store.mergeRemoteChanges(() => store.loadStoreSnapshot(payload.snapshot))
						revisionRef.current = payload.revision
						return
					}
					applyEvents(payload.events ?? [])
					revisionRef.current = Math.max(revisionRef.current, payload.revision ?? 0)
				}

				cleanupStore = store.listen(
					(entry: any) => {
						const changes: ChangeSet = {
							added: Object.values(entry.changes.added),
							updated: Object.values(entry.changes.updated).map((pair: any) => pair[1]),
							removed: Object.values(entry.changes.removed).map((record: any) => record.id),
						}
						enqueue(async () => {
							const response = await fetch('/api/changes', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ since: revisionRef.current, changes }),
							})
							const payload = await response.json()
							if (!response.ok && response.status !== 409) {
								throw new Error(payload.error ?? `Save failed: ${response.status}`)
							}
							applyServerResponse(payload)
						})
					},
					{ source: 'user', scope: 'document' },
				)

				const poll = () => {
					enqueue(async () => {
						const response = await fetch(`/api/changes?since=${revisionRef.current}`, { cache: 'no-store' })
						if (!response.ok) throw new Error(`Polling failed: ${response.status}`)
						applyServerResponse(await response.json())
					})
				}
				pollTimer = window.setInterval(poll, 500)
				setStoreWithStatus({ status: 'synced-remote', store, connectionStatus: 'online' })
			} catch (error) {
				if (!cancelled) setStoreWithStatus({ status: 'error', error: error as Error })
			}
		}

		start()
		return () => {
			cancelled = true
			cleanupStore?.()
			if (pollTimer !== undefined) window.clearInterval(pollTimer)
		}
	}, [])

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw store={storeWithStatus} components={components} onMount={startViewBridge} />
		</div>
	)
}

export default App
