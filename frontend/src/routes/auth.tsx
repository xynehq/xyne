import { createFileRoute, redirect } from "@tanstack/react-router"
import { useState, useEffect } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

export const description =
  "A login form with Google OAuth and Keycloak SSO options."

export const containerClassName =
  "w-full h-screen flex items-center justify-center px-4"

interface KeycloakConfig {
  baseUrl: string
  realm: string
  clientId: string
  loginUrl: string
}

export default function LoginForm() {
  const logger = console
  const [keycloakConfig, setKeycloakConfig] = useState<KeycloakConfig | null>(null)
  const [keycloakEnabled, setKeycloakEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showEmailLogin, setShowEmailLogin] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  // Get route data for any errors from beforeLoad
  const route = Route.useRouteContext()
  
  useEffect(() => {
    if (route?.error) {
      setError(route.error)
    }
  }, [route?.error])

  useEffect(() => {
    // Fetch Keycloak configuration
    const fetchKeycloakConfig = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/config`)
        if (response.ok) {
          const config = await response.json()
          setKeycloakConfig(config)
          setKeycloakEnabled(true)
          logger.info("Keycloak configuration loaded:", config)
        } else {
          logger.warn("Keycloak configuration not available")
        }
      } catch (error) {
        logger.error("Failed to fetch Keycloak configuration:", error)
      }
    }

    fetchKeycloakConfig()
  }, [])

  const handleGoogleLogin = () => {
    logger.info("User clicked login with Google")
    const redirectUrl = `${import.meta.env.VITE_API_BASE_URL}/v1/auth/callback`
    window.location.href = redirectUrl
  }

  const handleKeycloakLogin = () => {
    if (!keycloakConfig) {
      logger.error("Keycloak configuration not available")
      return
    }

    logger.info("User clicked login with Keycloak SSO")
    
    // Build Keycloak authorization URL - make sure it goes to user realm, not admin
    const params = new URLSearchParams({
      client_id: keycloakConfig.clientId,
      redirect_uri: `${window.location.origin}/auth`,
      response_type: "code",
      scope: "openid email profile",
      state: Math.random().toString(36).substring(2, 15),
    })

    // Use the user realm URL, not admin realm
    const userLoginUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.realm}/protocol/openid-connect/auth`
    const authUrl = `${userLoginUrl}?${params.toString()}`
    
    logger.info("Redirecting to Keycloak:", authUrl)
    window.location.href = authUrl
  }

  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      logger.info("Attempting email/password login for:", email)
      
      // Use our backend endpoint for secure authentication
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          password: password,
        }),
        credentials: 'include',
      })

      if (response.ok) {
        await response.json() // Parse response but don't store result
        logger.info('Email/password authentication successful')
        
        // Cookies are set by the server, no need to store tokens manually
        // Just redirect to home - the cookies will be sent automatically
        window.location.href = '/'
      } else {
        const errorData = await response.json()
        logger.error('Email/password login failed:', errorData)
        setError(errorData.error || 'Invalid email or password')
      }
    } catch (error) {
      logger.error('Login error:', error)
      setError('Login failed. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex w-full h-full justify-center">
      <div className="max-w-sm flex items-center">
        <Card className="h-auto">
          <CardHeader>
            <CardTitle className="text-2xl">Login</CardTitle>
            <CardDescription>
              Choose your preferred login method
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              {/* Error Message */}
              {error && (
                <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
                  {error}
                </div>
              )}

              {!showEmailLogin ? (
                <>
                  {/* Google OAuth Button */}
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleGoogleLogin}
                  >
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24">
                      <path
                        fill="currentColor"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="currentColor"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    Login with Google
                  </Button>

                  {/* Separator */}
                  {keycloakEnabled && (
                    <>
                      <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-white px-2 text-gray-500">
                            Or continue with
                          </span>
                        </div>
                      </div>

                      {/* Keycloak SSO Button */}
                      <Button
                        variant="default"
                        className="w-full"
                        onClick={handleKeycloakLogin}
                      >
                        <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M7.4 8.8h5.2L14 7h-5c-.9 0-1.6.7-1.6 1.6v6.8c0 .9.7 1.6 1.6 1.6h5L12.6 15H7.4V8.8z"/>
                          <path d="M17 7v10l-3-5 3-5z"/>
                        </svg>
                        Login with SSO
                      </Button>

                      {/* Email/Password Option */}
                      <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-white px-2 text-gray-500">
                            Or
                          </span>
                        </div>
                      </div>

                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => setShowEmailLogin(true)}
                      >
                        <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                        </svg>
                        Login with Email & Password
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <>
                  {/* Email/Password Form */}
                  <form onSubmit={handleEmailPasswordLogin} className="grid gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="debojyoti.mandal@juspay.in"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="password">Password</Label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" className="w-full" disabled={isLoading}>
                      {isLoading ? "Signing in..." : "Sign in"}
                    </Button>
                  </form>

                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      setShowEmailLogin(false)
                      setError(null)
                      setEmail("")
                      setPassword("")
                    }}
                  >
                    ← Back to other options
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/auth")({
  beforeLoad: async () => {
    // Check if user is already authenticated
    const res = await api.me.$get()
    if (res.ok) {
      const userWorkspace = await res.json()
      // If User & Workspace exists, don't let user visit /auth
      if (userWorkspace?.user && userWorkspace?.workspace) {
        throw redirect({ to: "/" })
      }
      return await res.json()
    }
    
    // Check for Keycloak OAuth callback
    const urlParams = new URLSearchParams(window.location.search)
    const code = urlParams.get('code')
    const state = urlParams.get('state')
    const error = urlParams.get('error')
    
    if (error) {
      console.error('Keycloak OAuth error:', error)
      // Remove error from URL and show error message
      window.history.replaceState({}, document.title, '/auth')
      return { error: error }
    }
    
    if (code) {
      console.log('Processing Keycloak OAuth callback')
      try {
        // Exchange code for tokens
        const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/callback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ code, state }),
          credentials: 'include',
        })
        
        if (response.ok) {
          await response.json() // Parse response but don't store tokens
          console.log('Keycloak authentication successful')
          
          // Cookies should be set by the server automatically
          // Remove code from URL and redirect to home
          window.history.replaceState({}, document.title, '/')
          throw redirect({ to: "/" })
        } else {
          const errorData = await response.json()
          console.error('Keycloak token exchange failed:', errorData)
          // Remove code from URL and show error
          window.history.replaceState({}, document.title, '/auth')
          return { error: errorData.error || 'Authentication failed' }
        }
      } catch (error) {
        console.error('Keycloak callback processing error:', error)
        window.history.replaceState({}, document.title, '/auth')
        return { error: 'Authentication failed' }
      }
    }
  },
  component: LoginForm,
  errorComponent: errorComponent,
})
