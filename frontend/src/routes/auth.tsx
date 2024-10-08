import { createFileRoute } from '@tanstack/react-router'

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import pino from 'pino'
import { getLogger } from '@shared/logger'
import { LOGGERTYPES } from '@shared/types'

export const description =
  "A login form with email and password. There's an option to login with Google and a link to sign up if you don't have an account."

export const containerClassName =
  "w-full h-screen flex items-center justify-center px-4"

export default function LoginForm() {
  const logger:pino.Logger = getLogger(LOGGERTYPES.client)
  logger.info('LOGIN WITH GOOGLE CLICKED')
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
                    logger.info('User Clicked login with google')
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
  component: LoginForm
})