import { TriangleAlert } from "lucide-react"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function ErrorState({
  error,
  retry,
}: {
  error: Error
  retry: () => void
}) {
  return (
    <Alert variant="error">
      <TriangleAlert />
      <AlertTitle>Unable to load data</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      <AlertAction>
        <Button onClick={retry} size="xs" type="button" variant="ghost">
          Try again
        </Button>
      </AlertAction>
    </Alert>
  )
}
