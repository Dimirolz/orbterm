import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { api, stackPartial, stackUp, type AgentInfo } from './api'
import { CodexTerminal } from './CodexTerminal'
import './App.css'

type AgentAction = 'start' | 'stop' | 'stack-up' | 'diff' | 'delete'
type OpenDiff = { n: number; name: string; patch: string; version: string }

const REPO_DIR = '/home/dmitrijilin/projects/shilo-ai-mono'

const vscodeSshUrl = (machine: string) =>
  `vscode://vscode-remote/ssh-remote+${encodeURIComponent(`${machine}@orb`)}${REPO_DIR}`

const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default function App() {
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [diff, setDiff] = useState<OpenDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: api.list,
    initialData: [] satisfies AgentInfo[],
    notifyOnChangeProps: ['data'],
    refetchInterval: 2000,
  })
  const agents = agentsQuery.data

  const diffStatus = useQuery({
    queryKey: ['diff-status', diff?.n],
    queryFn: () => api.diffStatus(diff!.n),
    enabled: diff !== null,
    notifyOnChangeProps: ['data'],
    refetchInterval: 2000,
  })

  useEffect(() => {
    if (diff === null || diffStatus.data === undefined || diffStatus.data.version === diff.version) return

    let cancelled = false
    api
      .diff(diff.n)
      .then(({ diff: patch }) => {
        if (cancelled) return
        setDiff((current) =>
          current?.n === diff.n
            ? { ...current, patch, version: diffStatus.data.version }
            : current,
        )
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })

    return () => {
      cancelled = true
    }
  }, [diff, diffStatus.data])

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy === key) return
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      await agentsQuery.refetch()
      setBusy(null)
    }
  }

  const createAgent = async () => {
    if (busy === 'new') return
    setBusy('new')
    setError(null)
    try {
      const created = await api.create()
      setSelected(created.n)
      for (let i = 0; i < 10; i++) {
        const result = await agentsQuery.refetch()
        if (result.data?.some((a) => a.n === created.n)) return
        await sleep(500)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const sel = agents.find((a) => a.n === selected) ?? null

  return (
    <div id="app">
      <aside id="side">
        <header>
          <span className="brand">
            <span className="wordmark">
              keen<span className="dot" />term
            </span>
          </span>
          <button
            className="primary"
            disabled={busy === 'new'}
            onClick={createAgent}
          >
            {busy === 'new' ? 'cloning…' : '+ new'}
          </button>
        </header>

        <div id="list">
          {agents.map((a) => (
            <AgentRow
              key={a.n}
              agent={a}
              selected={a.n === selected}
              busy={busy}
              onSelect={() => setSelected(a.n)}
              onAction={(action) => {
                const key = `${action}-${a.n}`
                if (action === 'start') run(key, () => api.start(a.n))
                if (action === 'stop') run(key, () => api.stop(a.n))
                if (action === 'stack-up') run(key, () => api.stackUp(a.n))
                if (action === 'diff')
                  run(key, async () => {
                    const status = await api.diffStatus(a.n)
                    const { diff: patch } = await api.diff(a.n)
                    setDiff({ n: a.n, name: a.name, patch, version: status.version })
                  })
                if (action === 'delete' && confirm(`delete agent ${a.n} (VM ${a.name})?`))
                  run(key, async () => {
                    await api.remove(a.n)
                    setSelected((cur) => (cur === a.n ? null : cur))
                  })
              }}
            />
          ))}
          {agents.length === 0 && <div className="hint">no agents yet — create one</div>}
        </div>

        <footer>
          {agents.length} agent{agents.length === 1 ? '' : 's'} ·{' '}
          {agents.filter((a) => a.state === 'running').length} running
        </footer>
      </aside>

      <main id="main">
        {sel === null && (
          <div className="center dim">
            <div className="big">◍</div>
            <div>select an agent</div>
          </div>
        )}
        {sel !== null && sel.state !== 'running' && (
          <div className="center">
            <div className="dim">
              agent {sel.n} <span className="mono">({sel.name})</span> is <b>{sel.state}</b>
            </div>
            <button
              className="primary"
              disabled={busy === `start-${sel.n}`}
              onClick={() => run(`start-${sel.n}`, () => api.start(sel.n))}
            >
              {busy === `start-${sel.n}` ? 'starting…' : 'start VM'}
            </button>
          </div>
        )}
        {sel !== null && sel.state === 'running' && <CodexTerminal machine={sel.name} />}
      </main>

      {diff && (
        <div className="overlay" onClick={() => setDiff(null)}>
          <div className="panel diff-panel" onClick={(e) => e.stopPropagation()}>
            <header>
              <span>diff · {diff.name}</span>
              <button onClick={() => setDiff(null)}>×</button>
            </header>
            <Suspense fallback={<div className="empty-diff">loading diff…</div>}>
              <DiffViewer key={diff.version} patch={diff.patch} />
            </Suspense>
          </div>
        </div>
      )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error} <span className="dim">— click to dismiss</span>
        </div>
      )}
    </div>
  )
}

function AgentRow({
  agent: a,
  selected,
  busy,
  onSelect,
  onAction,
}: {
  agent: AgentInfo
  selected: boolean
  busy: string | null
  onSelect: () => void
  onAction: (action: AgentAction) => void
}) {
  const running = a.state === 'running'
  const act = (action: AgentAction) => (e: React.MouseEvent) => {
    e.stopPropagation()
    onAction(action)
  }
  const openCode = (e: React.MouseEvent) => {
    e.stopPropagation()
    window.location.href = vscodeSshUrl(a.name)
  }
  const pending = (action: string) => busy === `${action}-${a.n}`
  const rowBusy = busy?.endsWith(`-${a.n}`) ?? false
  const up = stackUp(a.stack)
  const partial = stackPartial(a.stack)

  return (
    <div className={'row' + (selected ? ' sel' : '')} onClick={onSelect}>
      <div className="top">
        <span className={'dot ' + (running ? 'run' : 'off')} />
        <span className="name">agent {a.n}</span>
        {(up || partial) && (
          <span
            className={'stack ' + (up ? 'up' : 'partial')}
            title={`pg ${a.stack.pg ? '✓' : '✗'} · redis ${a.stack.redis ? '✓' : '✗'} · hasura ${a.stack.hasura ? '✓' : '✗'}`}
          >
            {up ? 'stack' : 'stack!'}
          </span>
        )}
        {a.codex &&
          (a.working ? (
            <span className="codex work">● working</span>
          ) : (
            <span className="codex idle">idle</span>
          ))}
      </div>
      <div className="acts">
        {running ? (
          <button disabled={rowBusy} onClick={act('stop')}>
            {pending('stop') ? '…' : 'stop'}
          </button>
        ) : (
          <button disabled={rowBusy} onClick={act('start')}>
            {pending('start') ? '…' : 'start'}
          </button>
        )}
        {running && !up && (
          <button disabled={rowBusy} onClick={act('stack-up')}>
            {pending('stack-up') ? '…' : 'fix stack'}
          </button>
        )}
        {running && (
          <button onClick={openCode} title={`Open ${a.name} in VS Code Remote-SSH`}>
            code
          </button>
        )}
        {running && (
          <button disabled={rowBusy} onClick={act('diff')}>
            {pending('diff') ? '…' : 'diff'}
          </button>
        )}
        <button className="danger" disabled={rowBusy} onClick={act('delete')}>
          {pending('delete') ? '…' : 'rm'}
        </button>
      </div>
    </div>
  )
}
