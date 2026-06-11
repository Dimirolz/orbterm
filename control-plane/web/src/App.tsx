import { useCallback, useEffect, useState } from 'react'
import { api, type AgentInfo } from './api'
import { CodexTerminal } from './CodexTerminal'
import './App.css'

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [doctor, setDoctor] = useState<{ name: string; output: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setAgents(await api.list())
    } catch (e) {
      console.warn(e)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const sel = agents.find((a) => a.n === selected) ?? null

  return (
    <div id="app">
      <aside id="side">
        <header>
          <span className="brand">
            <span className="orb" /> orb
          </span>
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => run('new', api.create)}
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
                if (action === 'doctor')
                  run(key, async () => {
                    const { output } = await api.doctor(a.n)
                    setDoctor({ name: a.name, output })
                  })
                if (action === 'delete' && confirm(`delete agent ${a.n} (VM ${a.name})?`))
                  run(key, async () => {
                    await api.remove(a.n)
                    if (selected === a.n) setSelected(null)
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
              disabled={busy !== null}
              onClick={() => run(`start-${sel.n}`, () => api.start(sel.n))}
            >
              {busy === `start-${sel.n}` ? 'starting…' : 'start VM'}
            </button>
          </div>
        )}
        {sel !== null && sel.state === 'running' && <CodexTerminal machine={sel.name} />}
      </main>

      {doctor && (
        <div className="overlay" onClick={() => setDoctor(null)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <header>
              <span>doctor · {doctor.name}</span>
              <button onClick={() => setDoctor(null)}>×</button>
            </header>
            <pre>{doctor.output}</pre>
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
  onAction: (action: 'start' | 'stop' | 'doctor' | 'delete') => void
}) {
  const running = a.state === 'running'
  const act = (action: 'start' | 'stop' | 'doctor' | 'delete') => (e: React.MouseEvent) => {
    e.stopPropagation()
    onAction(action)
  }
  const pending = (action: string) => busy === `${action}-${a.n}`

  return (
    <div className={'row' + (selected ? ' sel' : '')} onClick={onSelect}>
      <div className="top">
        <span className={'dot ' + (running ? 'run' : 'off')} />
        <span className="name">agent {a.n}</span>
        {a.codex &&
          (a.working ? (
            <span className="codex work">● working</span>
          ) : (
            <span className="codex idle">idle</span>
          ))}
      </div>
      <div className="acts">
        {running ? (
          <button disabled={busy !== null} onClick={act('stop')}>
            {pending('stop') ? '…' : 'stop'}
          </button>
        ) : (
          <button disabled={busy !== null} onClick={act('start')}>
            {pending('start') ? '…' : 'start'}
          </button>
        )}
        {running && (
          <button disabled={busy !== null} onClick={act('doctor')}>
            {pending('doctor') ? '…' : 'doctor'}
          </button>
        )}
        <button className="danger" disabled={busy !== null} onClick={act('delete')}>
          {pending('delete') ? '…' : 'rm'}
        </button>
      </div>
    </div>
  )
}
