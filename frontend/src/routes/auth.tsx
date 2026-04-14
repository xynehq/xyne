import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

// Import assets using Vite's asset handling
import xyneLogoSvg from "@/assets/xyne-logo.svg"
import signinBackgroundPng from "@/assets/signin-background.png"
import signinCenterImagePng from "@/assets/signin-center-image.png"
import googleIconSvg from "@/assets/google-icon.svg"

type AuthProvidersResponse = {
  googleWebEnabled: boolean
  keycloakWebEnabled: boolean
}

const XyneLogo = () => (
  <img
    src={xyneLogoSvg}
    alt="Xyne Logo"
    width="120"
    height="25"
    className="object-contain"
  />
)

const authSearchSchema = z.object({
  error: z.string().optional(),
})

const authErrorMessages: Record<string, string> = {
  workspace_mismatch:
    "Your email is already provisioned in a different workspace for this deployment.",
  keycloak_unavailable:
    "Keycloak login is not configured or is currently unavailable.",
  keycloak_failed: "Keycloak login failed. Please try again.",
  access_denied: "Login was canceled or denied.",
}

const getAuthErrorMessage = (error?: string) =>
  (error && authErrorMessages[error]) ||
  (error ? "Login failed. Please try again." : null)

export default function LoginForm() {
  const providers = Route.useLoaderData()
  const { error } = Route.useSearch()
  const authError = getAuthErrorMessage(error)

  const handleGoogleLogin = async () => {
    try {
      window.location.assign(`${window.location.origin}/v1/auth/callback`)
    } catch (error) {
      console.error("Failed to start Google login:", error)
    }
  }

  const handleKeycloakLogin = async () => {
    try {
      window.location.assign("/v1/auth/keycloak/start")
    } catch (error) {
      console.error("Failed to start Keycloak login:", error)
    }
  }

  return (
    <div
      className="w-full h-screen relative bg-cover bg-center bg-no-repeat flex items-center justify-center light bg-white"
      style={{
        backgroundImage: `url('${signinBackgroundPng}')`,
      }}
      data-theme="light"
    >
      {/* Main Container - centered login layout */}
      <div
        className="bg-white rounded-3xl overflow-hidden absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-black max-w-[1168px] h-[630px] px-[17px] py-[13px]"
      >
        {/* Horizontal Flex Container */}
        <div className="flex w-full h-full gap-4">
          {/* Left Section - Hero Content */}
          <div
            className="relative bg-cover bg-center bg-no-repeat flex items-center justify-center rounded-2xl overflow-hidden w-[619px] h-[604px]"
            style={{
              backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.00) 44.74%, rgba(0, 0, 0, 0.56) 117.43%), url('${signinCenterImagePng}')`,
            }}
          >
            {/* Text Content */}
            <div
              className="relative z-10 text-white flex flex-col items-start h-full pt-[60%] pl-[30px] pr-[65px] pb-[45px] gap-4"
            >
              {/* Main Heading */}
              <h1
                className="text-[32px] font-semibold leading-normal tracking-[0.2px] max-w-[400px] -ml-[15px]"
              >
                The Unified AI Platform
                <br />
                for your enterprise
              </h1>

              {/* Description */}
              <p
                className="text-base font-normal leading-normal tracking-[0.2px] text-white/90 -ml-[15px]"
              >
                The full-stack AI OS that's open-source,
                <br />
                on-prem, and enterprise-grade with determinism &
                <br />
                governance built-in by design.
              </p>
            </div>
          </div>

          {/* Right Section - Login Form */}
          <div
            className="rounded-2xl flex flex-col items-center justify-center text-black w-[533px] h-[604px] px-10 pt-[45px] pb-[50px] gap-[70px] bg-transparent"
          >
            {/* Xyne Logo */}
            <div className="-mt-5">
              <XyneLogo />
            </div>

            {/* Welcome Section and Button */}
            <div className="w-full flex flex-col items-center gap-[50px]">
              {/* Welcome Text */}
              <div className="text-center flex flex-col gap-2">
                <h2
                  className="font-bold text-xl font-inter text-[#3B4145] leading-normal"
                >
                  Welcome Back
                </h2>
                <p
                  className="text-xs font-inter font-normal text-[#788187] leading-normal"
                >
                  Please choose a sign-in method to continue
                </p>
              </div>

              <div className="w-[409px] flex flex-col items-center gap-4 mt-10">
                {authError && (
                  <div className="w-full rounded-2xl border border-[#F1C9C9] bg-[#FFF5F5] px-4 py-3 text-sm text-[#9F2D2D]">
                    {authError}
                  </div>
                )}

                {providers.googleWebEnabled && (
                  <Button
                    className="h-12 bg-black text-white hover:bg-gray-800 flex items-center justify-center gap-3 rounded-full text-sm font-inter font-medium w-full"
                    onClick={handleGoogleLogin}
                  >
                    <img
                      src={googleIconSvg}
                      alt="Google"
                      className="h-5 w-5"
                    />
                    Continue with Google
                  </Button>
                )}

                {providers.keycloakWebEnabled && (
                  <Button
                    variant="outline"
                    className="h-12 border-[#C7D0D9] bg-white text-[#28323B] hover:bg-[#F5F7F9] flex items-center justify-center gap-3 rounded-full text-sm font-inter font-medium w-full"
                    onClick={handleKeycloakLogin}
                  >
                    Continue with Keycloak
                  </Button>
                )}

                {!providers.googleWebEnabled && !providers.keycloakWebEnabled && (
                  <p className="w-full text-center text-sm font-inter text-[#788187]">
                    No web login provider is configured for this deployment.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/auth")({
  validateSearch: (search) => authSearchSchema.parse(search),
  beforeLoad: async () => {
    // Get user timezone
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

    const res = await api.me.$get({
      query: { timeZone },
    })
    if (res.ok) {
      // TODO: to type this response
      const userWorkspace = await res.json()
      // If User & Workspace exists, don't let user visit /auth
      if (userWorkspace?.user && userWorkspace?.workspace) {
        throw redirect({ to: "/" })
      }
      return userWorkspace
    }
  },
  loader: async (): Promise<AuthProvidersResponse> => {
    const res = await api.auth.providers.$get()
    if (!res.ok) {
      throw new Error("Failed to load auth providers")
    }
    return (await res.json()) as AuthProvidersResponse
  },
  component: LoginForm,
  errorComponent: errorComponent,
})
