import { createFileRoute } from '@tanstack/react-router'
import CallPage from '@/components/CallPage'

export const Route = createFileRoute('/call')({
  component: CallPage,
})
