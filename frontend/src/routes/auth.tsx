import { createFileRoute, redirect } from '@tanstack/react-router'

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { api } from '@/api'

export const description =
  "A login form with email and password. There's an option to login with Google and a link to sign up if you don't have an account."

export const containerClassName =
  "w-full h-screen flex items-center justify-center px-4"

export default function LoginForm() {
  return (
    <div className='flex w-full h-full justify-center'>
        <div className='max-w-sm flex items-center'>
            <Card className="h-auto">
            <CardHeader>
                <CardTitle className="text-2xl">Login</CardTitle>
                <CardDescription>
                Login with your workspace google account
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid gap-4">
                <Button variant="outline" className="w-full" onClick={(e) => {
                  const redirectUrl = `${import.meta.env.VITE_API_BASE_URL}/v1/auth/callback`;
                    window.location.href = redirectUrl
                }}>
                    Login with Google
                </Button>
                </div>
            </CardContent>
            </Card>
        </div>
    </div>
  )
}

export const Route = createFileRoute('/auth')({
  beforeLoad: async () => {
    const res = await api.api.me.$get();
    if (res.ok) {
      const userWorkspace = await res.json();
      // If User & Workspace exists, don't let user visit /auth
      if (userWorkspace?.user && userWorkspace?.workspace) {
        throw redirect({ to: '/' })
      }
    }
  },
  component: LoginForm
})