import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { ThemeProvider } from "@/components/shell/theme-provider.tsx"

import App from "./App.tsx"

const queryClient = new QueryClient()

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
