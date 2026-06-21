import { useQuery } from '@tanstack/react-query'
import { formatForDisplay, useHotkeys } from '@tanstack/react-hotkeys'
import { Code2, FileDiff, Play, Square, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { api, stackUp, type AgentInfo } from './api'
import { CodexTerminal } from './CodexTerminal'
import './App.css'

type AgentAction = 'start' | 'stop' | 'stack-up' | 'diff' | 'delete'
type OpenDiff = { n: number; name: string; patch: string; version: string }
type AgentLabels = Record<string, string>

const REPO_DIR = '/home/dmitrijilin/projects/shilo-ai-mono'
const LABELS_KEY = 'keenterm.agentLabels'

const vscodeSshUrl = (machine: string) =>
  `vscode://vscode-remote/ssh-remote+${encodeURIComponent(`${machine}@orb`)}${REPO_DIR}`

const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const readLabels = (): AgentLabels => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
const displayName = (agent: AgentInfo, labels: AgentLabels) => labels[agent.name] || `agent ${agent.n}`
const aliasName = (agent: AgentInfo, labels: AgentLabels) => labels[agent.name] ?? ''

export default function App() {
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [diff, setDiff] = useState<OpenDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [labels, setLabels] = useState<AgentLabels>(() => readLabels())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [openTerminals, setOpenTerminals] = useState<string[]>([])

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

  const selectAgent = (n: number | null) => {
    setSelected(n)
  }

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
      selectAgent(created.n)
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

  // Keyboard agent switching. We use ⌃⌘ (Control+Meta) combos on purpose:
  //  - ⌘ alone (⌘1..9, ⌘[ ]) is reserved by Chrome and can't be intercepted;
  //  - plain/Ctrl keys are swallowed by the xterm PTY while Codex has focus;
  //  - ⌃⌘ is free in Chrome AND xterm ignores Meta combos, so the page sees it
  //    even while typing in Codex. TanStack's ignoreInputs default also lets
  //    ctrl/meta combos fire inside inputs (the xterm helper <textarea>).
  const switchBy = (delta: number) => {
    if (agents.length === 0) return
    const idx = agents.findIndex((a) => a.n === selected)
    const next = idx === -1 ? 0 : (idx + delta + agents.length) % agents.length
    selectAgent(agents[next].n)
  }
  const switchTo = (n: number) => {
    if (agents.some((a) => a.n === n)) selectAgent(n)
  }
  const deleteAgent = (a: AgentInfo) => {
    if (!confirm(`delete agent ${a.n} (VM ${a.name})?`)) return
    run(`delete-${a.n}`, async () => {
      await api.remove(a.n)
      setLabels((current) => {
        const next = { ...current }
        delete next[a.name]
        localStorage.setItem(LABELS_KEY, JSON.stringify(next))
        return next
      })
      setSelected((cur) => (cur === a.n ? null : cur))
    })
  }
  const renameAgent = (a: AgentInfo, name: string) => {
    const clean = name.trim()
    setLabels((current) => {
      const next = { ...current }
      if (clean) next[a.name] = clean
      else delete next[a.name]
      localStorage.setItem(LABELS_KEY, JSON.stringify(next))
      return next
    })
    setRenaming(null)
  }
  const newAgentHint = formatForDisplay('Control+Meta+N')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault()
        switchTo(Number(e.code.slice('Digit'.length)))
        return
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyB') {
        e.preventDefault()
        setSidebarOpen((open) => !open)
        return
      }
      if (
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.code === 'Backspace' || e.code === 'Delete')
      ) {
        const a = agents.find((agent) => agent.n === selected)
        if (a) {
          e.preventDefault()
          deleteAgent(a)
        }
        return
      }

      if (!e.ctrlKey || !e.metaKey || e.altKey || e.shiftKey) return

      if (e.code === 'KeyN') {
        e.preventDefault()
        createAgent()
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  })

  useHotkeys([
    { hotkey: 'Control+Meta+ArrowDown', callback: () => switchBy(1) },
    { hotkey: 'Control+Meta+ArrowUp', callback: () => switchBy(-1) },
    ...(['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const).map((k) => ({
      hotkey: `Control+Meta+${k}` as const,
      callback: () => switchTo(Number(k)),
    })),
  ])

  const sel = agents.find((a) => a.n === selected) ?? null

  useEffect(() => {
    const running = new Set(agents.filter((a) => a.state === 'running').map((a) => a.name))
    setOpenTerminals((current) => current.filter((machine) => running.has(machine)))
  }, [agents])

  useEffect(() => {
    if (sel?.state !== 'running') return
    setOpenTerminals((current) => (current.includes(sel.name) ? current : [...current, sel.name]))
  }, [sel?.name, sel?.state])

  return (
    <div id="app" className={sidebarOpen ? '' : 'sidebar-closed'}>
      {sidebarOpen && (
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
              title={`create new agent with ${newAgentHint}`}
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
                labels={labels}
                onSelect={() => selectAgent(a.n)}
                renaming={renaming === a.n}
                onRenameStart={() => setRenaming(a.n)}
                onRenameCancel={() => setRenaming(null)}
                onRename={(name) => renameAgent(a, name)}
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
                  if (action === 'delete') deleteAgent(a)
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
      )}

      <main id="main">
        {!sidebarOpen && (
          <div className="agent-strip">
            {agents.map((a) => (
              <button
                key={a.n}
                className={`agent-tab ${a.state === 'running' ? (a.working ? 'working' : 'idle') : 'stopped'}${
                  a.n === selected ? ' sel' : ''
                }`}
                onClick={() => selectAgent(a.n)}
                title={a.name}
              >
                <span className="agent-tab-label">{displayName(a, labels)}</span>
                {a.n >= 1 && a.n <= 9 && (
                  <span className="agent-tab-hint">
                    <span className="agent-tab-command">⌘</span>
                    <span>{a.n}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {sel === null && (
          <div className="center dim">
            <div className="big">◍</div>
            <div>select an agent</div>
          </div>
        )}
        {sel !== null && sel.state !== 'running' && (
          <div className="center">
            <div className="dim">
              {displayName(sel, labels)} <span className="mono">({sel.name})</span> is <b>{sel.state}</b>
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
        {openTerminals.map((machine) => (
          <CodexTerminal key={machine} machine={machine} active={sel?.name === machine && sel.state === 'running'} />
        ))}
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
  labels,
  renaming,
  onSelect,
  onRenameStart,
  onRenameCancel,
  onRename,
  onAction,
}: {
  agent: AgentInfo
  selected: boolean
  busy: string | null
  labels: AgentLabels
  renaming: boolean
  onSelect: () => void
  onRenameStart: () => void
  onRenameCancel: () => void
  onRename: (name: string) => void
  onAction: (action: AgentAction) => void
}) {
  const [draftName, setDraftName] = useState('')
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
  const hint = a.n >= 1 && a.n <= 9 ? formatForDisplay(`Meta+${a.n}`) : null
  const status = running ? (a.working ? 'working' : 'idle') : 'stopped'
  const label = displayName(a, labels)
  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraftName(aliasName(a, labels))
    onRenameStart()
  }
  const saveRename = () => {
    onRename(draftName)
  }

  return (
    <div className={`row ${status}` + (selected ? ' sel' : '')} onClick={onSelect}>
      <div className="top">
        {renaming ? (
          <input
            className="rename-input"
            value={draftName}
            autoFocus
            placeholder={`agent ${a.n}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={saveRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                saveRename()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                onRenameCancel()
              }
            }}
          />
        ) : (
          <span className="name" title={a.name} onDoubleClick={startRename}>
            {label}
          </span>
        )}
        {hint && (
          <kbd className="kbd-hint" title={`switch with ${hint}`}>
            {hint}
          </kbd>
        )}
      </div>
      <div className="acts">
        {running && !up && (
          <button disabled={rowBusy} onClick={act('stack-up')}>
            {pending('stack-up') ? '…' : 'fix stack'}
          </button>
        )}
        {running && (
          <button className="icon-btn" onClick={openCode} title={`Open ${a.name} in VS Code`}>
            <Code2 aria-hidden="true" />
            <span className="sr-only">Open in VS Code</span>
          </button>
        )}
        {running && (
          <button className="icon-btn" disabled={rowBusy} onClick={act('diff')} title="Show diff">
            {pending('diff') ? '…' : <FileDiff aria-hidden="true" />}
            <span className="sr-only">Show diff</span>
          </button>
        )}
        <button
          className="icon-btn"
          disabled={rowBusy}
          onClick={act(running ? 'stop' : 'start')}
          title={running ? 'Stop VM' : 'Start VM'}
        >
          {pending(running ? 'stop' : 'start') ? (
            '…'
          ) : running ? (
            <Square aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          <span className="sr-only">{running ? 'Stop VM' : 'Start VM'}</span>
        </button>
        <button className="icon-btn danger" disabled={rowBusy} onClick={act('delete')} title="Delete agent">
          {pending('delete') ? '…' : <Trash2 aria-hidden="true" />}
          <span className="sr-only">Delete agent</span>
        </button>
      </div>
    </div>
  )
}
