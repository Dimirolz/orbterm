import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// One live terminal for the selected agent. Scrollback survives remounts
// because the server buffers and replays each session's output.
export function CodexTerminal({ machine }: { machine: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current!
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 20000,
      theme: { background: '#1e1e1e' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/term?machine=${machine}`)
    ws.binaryType = 'arraybuffer'

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    ws.onopen = sendResize
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return // status frames; list polling covers it
      term.write(new Uint8Array(ev.data as ArrayBuffer))
    }
    const input = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0) {
        fit.fit()
        sendResize()
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [machine])

  return <div ref={ref} className="termwrap" />
}
