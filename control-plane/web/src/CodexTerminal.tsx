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
    const sendInput = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    }
    // Codex (crossterm) reads Shift+Enter as a CSI-u key event, not a control
    // char. Browsers collapse Shift+Enter to a bare CR, which Codex treats as
    // "submit". Synthesize the CSI-u press so crossterm decodes Enter+SHIFT and
    // inserts a newline instead. Only the press form is needed; Codex ignores
    // key releases.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === 'Enter' && ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
        if (ev.type === 'keydown') sendInput('\x1b[13;2u')
        return false
      }
      return true
    })
    const input = term.onData((data) => {
      sendInput(data)
    })

    // fit() resizes xterm's DOM, which re-fires the ResizeObserver; without a
    // guard this loops forever on container heights where rows flip N <-> N+1
    // (page visibly "jumps"). Only refit when the proposed grid actually differs.
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (el.offsetWidth === 0) return
        const dims = fit.proposeDimensions()
        if (!dims || (dims.cols === term.cols && dims.rows === term.rows)) return
        fit.fit()
        sendResize()
      })
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [machine])

  return <div ref={ref} className="termwrap" />
}
