import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// no StrictMode: it double-mounts CodexTerminal in dev, opening two
// websockets per selection and replaying the buffer twice
createRoot(document.getElementById('root')!).render(<App />)
