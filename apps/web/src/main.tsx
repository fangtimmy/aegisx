import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { ApiError } from "@/api/client"

import "./index.css"
import { ThemeProvider } from "@/components/shell/theme-provider.tsx"

import App from "./App.tsx"

/** Server-rejected requests (ApiError) are deterministic — retrying them
 * only delays the error state settling (default backoff is ~7s across 3
 * retries). Only transport-level failures are worth retrying. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !(error instanceof ApiError) && failureCount < 3,
    },
  },
})

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
