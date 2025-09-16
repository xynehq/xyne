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

interface FeatureToggles {
  googleLoginEnabled: boolean
  microsoftLoginEnabled: boolean
  linkedinLoginEnabled: boolean
  emailPasswordLoginEnabled: boolean
  passkeyLoginEnabled: boolean
  ssoLoginEnabled: boolean
}

export default function LoginForm() {
  const logger = console
  const [keycloakConfig, setKeycloakConfig] = useState<KeycloakConfig | null>(null)
  const [keycloakEnabled, setKeycloakEnabled] = useState(false)
  const [featureToggles, setFeatureToggles] = useState<FeatureToggles | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showEmailLogin, setShowEmailLogin] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [showPasskeyLogin, setShowPasskeyLogin] = useState(false)
  const [passkeyEmail, setPasskeyEmail] = useState("")
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false)

  // Helper function to check if any Keycloak options are enabled
  const hasAnyKeycloakOptions = () => {
    if (!featureToggles) return false
    return featureToggles.googleLoginEnabled || 
           featureToggles.microsoftLoginEnabled || 
           featureToggles.linkedinLoginEnabled || 
           featureToggles.emailPasswordLoginEnabled || 
           featureToggles.passkeyLoginEnabled || 
           featureToggles.ssoLoginEnabled
  }

  // Get route data for any errors from beforeLoad
  const route = Route.useRouteContext()
  
  useEffect(() => {
    if (route?.error) {
      setError(route.error)
    }
  }, [route?.error])

  useEffect(() => {
    // Fetch Keycloak configuration and feature toggles
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

    const fetchFeatureToggles = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/features`)
        if (response.ok) {
          const features = await response.json()
          setFeatureToggles(features)
          logger.info("Feature toggles loaded:", features)
        } else {
          logger.warn("Feature toggles not available")
        }
      } catch (error) {
        logger.error("Failed to fetch feature toggles:", error)
      }
    }

    fetchKeycloakConfig()
    fetchFeatureToggles()
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

  const handleGoogleKeycloakLogin = () => {
    if (!keycloakConfig) {
      logger.error("Keycloak configuration not available")
      return
    }

    logger.info("User clicked login with Google via Keycloak")
    
    // Build Keycloak authorization URL with Google identity provider hint
    const params = new URLSearchParams({
      client_id: keycloakConfig.clientId,
      redirect_uri: `${window.location.origin}/auth`,
      response_type: "code",
      scope: "openid email profile",
      state: Math.random().toString(36).substring(2, 15),
      kc_idp_hint: "google", // This will direct Keycloak to use Google as identity provider
    })

    // Use the user realm URL, not admin realm
    const userLoginUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.realm}/protocol/openid-connect/auth`
    const authUrl = `${userLoginUrl}?${params.toString()}`
    
    logger.info("Redirecting to Google via Keycloak:", authUrl)
    window.location.href = authUrl
  }

  const handleLinkedInKeycloakLogin = () => {
    if (!keycloakConfig) {
      logger.error("Keycloak configuration not available")
      return
    }

    logger.info("User clicked login with LinkedIn via Keycloak")
    
    // Build Keycloak authorization URL with LinkedIn identity provider hint
    const params = new URLSearchParams({
      client_id: keycloakConfig.clientId,
      redirect_uri: `${window.location.origin}/auth`,
      response_type: "code",
      scope: "openid email profile",
      state: Math.random().toString(36).substring(2, 15),
      kc_idp_hint: "linkedin", // This will direct Keycloak to use LinkedIn as identity provider
    })

    // Use the user realm URL, not admin realm
    const userLoginUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.realm}/protocol/openid-connect/auth`
    const authUrl = `${userLoginUrl}?${params.toString()}`
    
    logger.info("Redirecting to LinkedIn via Keycloak:", authUrl)
    window.location.href = authUrl
  }

  const handleMicrosoftKeycloakLogin = () => {
    if (!keycloakConfig) {
      logger.error("Keycloak configuration not available")
      return
    }

    logger.info("User clicked login with Microsoft via Keycloak")
    
    // Build Keycloak authorization URL with Microsoft identity provider hint
    const params = new URLSearchParams({
      client_id: keycloakConfig.clientId,
      redirect_uri: `${window.location.origin}/auth`,
      response_type: "code",
      scope: "openid email profile",
      state: Math.random().toString(36).substring(2, 15),
      kc_idp_hint: "microsoft", // This will direct Keycloak to use Microsoft as identity provider
    })

    // Use the user realm URL, not admin realm
    const userLoginUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.realm}/protocol/openid-connect/auth`
    const authUrl = `${userLoginUrl}?${params.toString()}`
    
    logger.info("Redirecting to Microsoft via Keycloak:", authUrl)
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

  const handlePasskeyEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsPasskeyLoading(true)
    setError(null)

    try {
      logger.info("Checking passkey availability for:", passkeyEmail)
      
      // Check if user has existing passkeys
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/webauthn-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: passkeyEmail,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        
        if (data.hasPasskey) {
          // User has existing passkey, start authentication
          await startPasskeyAuthentication(data.challenge)
        } else {
          // User doesn't have passkey, start registration
          await startPasskeyRegistration(data.challenge)
        }
      } else {
        const errorData = await response.json()
        logger.error('Passkey check failed:', errorData)
        setError(errorData.error || 'Failed to check passkey availability')
      }
    } catch (error) {
      logger.error('Passkey email check error:', error)
      setError('Failed to process passkey request. Please try again.')
    } finally {
      setIsPasskeyLoading(false)
    }
  }

  const startPasskeyAuthentication = async (challenge: string) => {
    try {
      logger.info("Starting passkey authentication")
      
      // Check if WebAuthn is supported
      if (!window.PublicKeyCredential) {
        setError('Passkeys are not supported in this browser')
        return
      }

      // Create authentication request
      const publicKeyCredentialRequestOptions = {
        challenge: Uint8Array.from(atob(challenge), c => c.charCodeAt(0)),
        timeout: 60000,
        userVerification: 'required' as UserVerificationRequirement,
      }

      // Request passkey authentication
      const credential = await navigator.credentials.get({
        publicKey: publicKeyCredentialRequestOptions
      }) as PublicKeyCredential

      if (credential) {
        // Send credential to backend for verification
        const authResponse = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/webauthn-verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: passkeyEmail,
            credential: {
              id: credential.id,
              rawId: Array.from(new Uint8Array(credential.rawId)),
              response: {
                authenticatorData: Array.from(new Uint8Array((credential.response as AuthenticatorAssertionResponse).authenticatorData)),
                clientDataJSON: Array.from(new Uint8Array(credential.response.clientDataJSON)),
                signature: Array.from(new Uint8Array((credential.response as AuthenticatorAssertionResponse).signature)),
              },
              type: credential.type,
            }
          }),
          credentials: 'include',
        })

        if (authResponse.ok) {
          logger.info('Passkey authentication successful')
          window.location.href = '/'
        } else {
          const errorData = await authResponse.json()
          logger.error('Passkey verification failed:', errorData)
          setError(errorData.error || 'Passkey authentication failed')
        }
      }
    } catch (error: any) {
      logger.error('Passkey authentication error:', error)
      if (error.name === 'NotAllowedError') {
        setError('Passkey authentication was cancelled or failed')
      } else if (error.name === 'SecurityError') {
        setError('Security error: Please ensure you are on a secure connection (HTTPS)')
      } else if (error.name === 'NotSupportedError') {
        setError('Passkeys are not supported on this device')
      } else {
        setError(`Passkey authentication failed: ${error.message || 'Please try again.'}`)
      }
    }
  }

  const startPasskeyRegistration = async (challenge: string) => {
    try {
      logger.info("Starting passkey registration for:", passkeyEmail)
      logger.info("Challenge received:", challenge)
      logger.info("Current hostname:", window.location.hostname)
      
      // Check if WebAuthn is supported
      if (!window.PublicKeyCredential) {
        setError('Passkeys are not supported in this browser')
        return
      }

      // Check if the current context is secure
      if (!window.isSecureContext) {
        setError('Passkeys require a secure context (HTTPS or localhost)')
        return
      }

      // Create registration request
      const publicKeyCredentialCreationOptions = {
        challenge: Uint8Array.from(atob(challenge), c => c.charCodeAt(0)),
        rp: {
          name: "Xyne",
          id: window.location.hostname,
        },
        user: {
          id: new TextEncoder().encode(passkeyEmail),
          name: passkeyEmail,
          displayName: passkeyEmail,
        },
        pubKeyCredParams: [{alg: -7, type: "public-key" as const}],
        authenticatorSelection: {
          userVerification: "required" as UserVerificationRequirement,
        },
        timeout: 60000,
        attestation: "direct" as AttestationConveyancePreference,
      }

      logger.info("Requesting passkey creation with options:", publicKeyCredentialCreationOptions)
      
      // Request passkey creation
      const credential = await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions
      }) as PublicKeyCredential

      logger.info("Passkey credential created:", credential)

      if (credential) {
        // Send credential to backend for registration
        const regResponse = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/keycloak/webauthn-register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: passkeyEmail,
            credential: {
              id: credential.id,
              rawId: Array.from(new Uint8Array(credential.rawId)),
              response: {
                attestationObject: Array.from(new Uint8Array((credential.response as AuthenticatorAttestationResponse).attestationObject)),
                clientDataJSON: Array.from(new Uint8Array(credential.response.clientDataJSON)),
              },
              type: credential.type,
            }
          }),
          credentials: 'include',
        })

        if (regResponse.ok) {
          logger.info('Passkey registration successful')
          window.location.href = '/'
        } else {
          const errorData = await regResponse.json()
          logger.error('Passkey registration failed:', errorData)
          setError(errorData.error || 'Passkey registration failed')
        }
      }
    } catch (error: any) {
      logger.error('Passkey registration error:', error)
      if (error.name === 'NotAllowedError') {
        setError('Passkey registration was cancelled or failed')
      } else if (error.name === 'SecurityError') {
        setError('Security error: Please ensure you are on a secure connection (HTTPS)')
      } else if (error.name === 'NotSupportedError') {
        setError('Passkeys are not supported on this device')
      } else {
        setError(`Passkey registration failed: ${error.message || 'Please try again.'}`)
      }
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <Card className="shadow-xl border-0 bg-white/95 backdrop-blur-sm">
          <CardHeader className="text-center pb-6 pt-6">
            <div className="mx-auto w-12 h-12 flex items-center justify-center mb-4">
              <img 
                src="/assets/logo.svg" 
                alt="Xyne Logo" 
                className="w-12 h-12 drop-shadow-sm"
              />
            </div>
            <CardTitle className="text-2xl font-bold text-gray-900 mb-2">Welcome to Xyne</CardTitle>
            <CardDescription className="text-gray-600 text-sm">
              Sign in to your account to continue
            </CardDescription>
          </CardHeader>
          <CardContent className="px-8 pb-6">
            <div className="space-y-4">
              {/* Error Message */}
              {error && (
                <div className="p-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg flex items-center">
                  <svg className="w-4 h-4 mr-2 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
                  </svg>
                  {error}
                </div>
              )}

              {!showEmailLogin && !showPasskeyLogin ? (
                <>
                  {/* Legacy Google Section */}
                  <div className="space-y-3">
                    <div className="text-center">
                      <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-700 mb-2">
                        Legacy Option
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="lg"
                      className="w-full h-10 bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all duration-200 shadow-sm"
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
                      Continue with Google
                    </Button>
                  </div>

                  {/* Separator */}
                  {keycloakEnabled && hasAnyKeycloakOptions() && (
                    <div className="relative my-5">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-gray-200" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-white px-4 text-gray-500 font-medium">Or continue with</span>
                      </div>
                    </div>
                  )}

                  {/* Keycloak Section */}
                  {keycloakEnabled && hasAnyKeycloakOptions() && (
                    <div className="space-y-3">
                      <div className="text-center">
                        <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 mb-2">
                          Keycloak Options
                        </div>
                      </div>
                      
                      {/* Google via Keycloak */}
                      {featureToggles?.googleLoginEnabled && (
                        <Button
                          variant="outline"
                          size="lg"
                          className="w-full h-10 bg-blue-50 border-blue-200 hover:bg-blue-100 hover:border-blue-300 transition-all duration-200 shadow-sm"
                          onClick={handleGoogleKeycloakLogin}
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
                        Continue with Google
                      </Button>
                      )}

                      {/* Microsoft via Keycloak */}
                      {featureToggles?.microsoftLoginEnabled && (
                        <Button
                          variant="outline"
                          size="lg"
                          className="w-full h-10 bg-blue-50 border-blue-200 hover:bg-blue-100 hover:border-blue-300 transition-all duration-200 shadow-sm"
                          onClick={handleMicrosoftKeycloakLogin}
                        >
                        <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zM24 11.4H12.6V0H24v11.4z"/>
                        </svg>
                        Continue with Microsoft
                      </Button>
                      )}

                      {/* LinkedIn via Keycloak */}
                      {featureToggles?.linkedinLoginEnabled && (
                        <Button
                          variant="outline"
                          size="lg"
                          className="w-full h-10 bg-blue-50 border-blue-200 hover:bg-blue-100 hover:border-blue-300 transition-all duration-200 shadow-sm"
                          onClick={handleLinkedInKeycloakLogin}
                        >
                        <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                        </svg>
                        Continue with LinkedIn
                      </Button>
                      )}

                      {/* SSO Option - Controlled by Feature Toggle */}
                      {featureToggles?.ssoLoginEnabled && (
                        <Button
                          variant="default"
                          size="lg"
                          className="w-full h-11 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 transition-all duration-200 shadow-sm"
                          onClick={handleKeycloakLogin}
                        >
                          <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M7.4 8.8h5.2L14 7h-5c-.9 0-1.6.7-1.6 1.6v6.8c0 .9.7 1.6 1.6 1.6h5L12.6 15H7.4V8.8z"/>
                            <path d="M17 7v10l-3-5 3-5z"/>
                          </svg>
                          Login with SSO
                        </Button>
                      )}

                      {/* Email/Password Option */}
                      {featureToggles?.emailPasswordLoginEnabled && (
                        <Button
                          variant="outline"
                          size="lg"
                          className="w-full h-10 bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all duration-200 shadow-sm"
                          onClick={() => setShowEmailLogin(true)}
                        >
                        <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                        </svg>
                        Login with Email & Password
                      </Button>
                      )}

                      {/* Passkey/WebAuthn Option */}
                      {featureToggles?.passkeyLoginEnabled && (
                        <Button
                          variant="outline"
                          size="lg"
                          className="w-full h-10 bg-emerald-50 border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300 transition-all duration-200 shadow-sm"
                          onClick={() => setShowPasskeyLogin(true)}
                        >
                        <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M17.81,4.47C17.73,4.47 17.65,4.45 17.58,4.41C17.5,4.38 17.42,4.33 17.36,4.27C17.3,4.22 17.25,4.15 17.22,4.07C17.18,4 17.16,3.92 17.16,3.84C17.16,3.76 17.18,3.68 17.22,3.6C17.25,3.53 17.3,3.46 17.36,3.4C17.42,3.35 17.5,3.3 17.58,3.27C17.65,3.24 17.73,3.22 17.81,3.22C17.89,3.22 17.97,3.24 18.04,3.27C18.12,3.3 18.2,3.35 18.25,3.4C18.31,3.46 18.36,3.53 18.39,3.6C18.43,3.68 18.45,3.76 18.45,3.84C18.45,3.92 18.43,4 18.39,4.07C18.36,4.15 18.31,4.22 18.25,4.27C18.2,4.33 18.12,4.38 18.04,4.41C17.97,4.45 17.89,4.47 17.81,4.47M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z"/>
                        </svg>
                        <div className="flex flex-col items-start text-left">
                          <span className="text-sm font-medium">Use Passkey</span>
                          <span className="text-xs text-emerald-600">Fingerprint, Face ID, or Security Key</span>
                        </div>
                      </Button>
                      )}
                    </div>
                  )}
                </>
              ) : showPasskeyLogin ? (
                <>
                  {/* Passkey Email Form */}
                  <div className="space-y-5">
                    <div className="text-center">
                      <div className="mx-auto w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center mb-3">
                        <svg className="w-5 h-5 text-emerald-600" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M17.81,4.47C17.73,4.47 17.65,4.45 17.58,4.41C17.5,4.38 17.42,4.33 17.36,4.27C17.3,4.22 17.25,4.15 17.22,4.07C17.18,4 17.16,3.92 17.16,3.84C17.16,3.76 17.18,3.68 17.22,3.6C17.25,3.53 17.3,3.46 17.36,3.4C17.42,3.35 17.5,3.3 17.58,3.27C17.65,3.24 17.73,3.22 17.81,3.22C17.89,3.22 17.97,3.24 18.04,3.27C18.12,3.3 18.2,3.35 18.25,3.4C18.31,3.46 18.36,3.53 18.39,3.6C18.43,3.68 18.45,3.76 18.45,3.84C18.45,3.92 18.43,4 18.39,4.07C18.36,4.15 18.31,4.22 18.25,4.27C18.2,4.33 18.12,4.38 18.04,4.41C17.97,4.45 17.89,4.47 17.81,4.47M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z"/>
                        </svg>
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-1">Passkey Authentication</h3>
                      <p className="text-sm text-gray-600 mb-3">
                        Use your fingerprint, Face ID, or security key
                      </p>
                    </div>
                    
                    <form onSubmit={handlePasskeyEmailSubmit} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="passkey-email" className="text-sm font-medium text-gray-700">Email address</Label>
                        <Input
                          id="passkey-email"
                          type="email"
                          placeholder="Enter your email address"
                          value={passkeyEmail}
                          onChange={(e) => setPasskeyEmail(e.target.value)}
                          className="h-11 border-gray-200 focus:border-emerald-500 focus:ring-emerald-500"
                          required
                        />
                      </div>
                      <Button 
                        type="submit" 
                        size="lg"
                        className="w-full h-11 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-700 hover:to-green-700 transition-all duration-200 shadow-sm" 
                        disabled={isPasskeyLoading}
                      >
                        {isPasskeyLoading ? (
                          <div className="flex items-center">
                            <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Processing...
                          </div>
                        ) : (
                          <div className="flex items-center">
                            <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z"/>
                            </svg>
                            Continue with Passkey
                          </div>
                        )}
                      </Button>
                    </form>

                    <Button
                      variant="ghost"
                      className="w-full text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                      onClick={() => {
                        setShowPasskeyLogin(false)
                        setError(null)
                        setPasskeyEmail("")
                      }}
                    >
                      ← Back to login options
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {/* Email/Password Form */}
                  <div className="space-y-5">
                    <div className="text-center">
                      <div className="mx-auto w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center mb-3">
                        <svg className="w-5 h-5 text-blue-600" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                        </svg>
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-1">Email & Password</h3>
                      <p className="text-sm text-gray-600">Sign in with your credentials</p>
                    </div>
                    
                    <form onSubmit={handleEmailPasswordLogin} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="email" className="text-sm font-medium text-gray-700">Email address</Label>
                        <Input
                          id="email"
                          type="email"
                          placeholder="Enter your email address"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="h-11 border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="password" className="text-sm font-medium text-gray-700">Password</Label>
                        <Input
                          id="password"
                          type="password"
                          placeholder="Enter your password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="h-11 border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                          required
                        />
                      </div>
                      <Button 
                        type="submit" 
                        size="lg"
                        className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 transition-all duration-200 shadow-sm" 
                        disabled={isLoading}
                      >
                        {isLoading ? "Signing in..." : "Sign in"}
                      </Button>
                    </form>

                    <Button
                      variant="ghost"
                      className="w-full text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                      onClick={() => {
                        setShowEmailLogin(false)
                        setError(null)
                        setEmail("")
                        setPassword("")
                      }}
                    >
                      ← Back to login options
                    </Button>
                  </div>
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
