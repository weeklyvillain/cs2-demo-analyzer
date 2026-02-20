import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ToastProvider } from './contexts/ToastContext'
import { ParsingStatusProvider } from './contexts/ParsingStatusContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <ParsingStatusProvider>
        <App />
      </ParsingStatusProvider>
    </ToastProvider>
  </React.StrictMode>,
)

