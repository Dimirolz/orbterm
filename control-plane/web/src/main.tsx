import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient()

// no StrictMode: it double-mounts CodexTerminal in dev, opening two
// websockets per selection and replaying the buffer twice
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)
