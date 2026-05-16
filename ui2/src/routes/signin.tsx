import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect } from "react"
import { BrandMark } from "@/components/BrandMark"
import { ThemeToggle } from "@/components/ThemeToggle"
import { ApiError, getMe } from "@/lib/api"

type SignInSearch = { error?: string }

const parseSearch = (v: Record<string, unknown>): SignInSearch => {
  const e = typeof v["error"] === "string" ? v["error"] : undefined
  return e ? { error: e } : {}
}

export const Route = createFileRoute("/signin")({
  validateSearch: parseSearch,
  component: SignInRoute,
})

function GoogleGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.68 9c0-.593.102-1.17.284-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.892 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
      />
    </svg>
  )
}

function KeycloakGlyph(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function SignInRoute(): JSX.Element {
  const navigate = useNavigate()
  const { error } = useSearch({ from: "/signin" })

  // If we already have a session, slip into the app
  useEffect((): void => {
    const probe = async (): Promise<void> => {
      try {
        await getMe()
        void navigate({ to: "/" })
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
          // eslint-disable-next-line no-console
          console.warn("getMe probe failed", err)
        }
      }
    }
    void probe()
  }, [navigate])

  return (
    <div className="relative flex min-h-full flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-4">
        <BrandMark />
        <ThemeToggle />
      </header>

      <main className="relative isolate flex flex-1 items-center justify-center px-6">
        <div className="halo pointer-events-none absolute inset-x-0 top-0 -z-10 h-72" />

        <div className="w-full max-w-md animate-fade-up text-center">
          <h1 className="font-display text-5xl leading-[1.05] tracking-tight">
            Welcome
            <em className="italic"> back</em>.
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
            Sign in to continue to your workspace.
          </p>

          <div className="mt-7 flex flex-col gap-2">
            <a
              href="/v1/auth/google/start"
              className="inline-flex h-11 items-center justify-center gap-2.5 rounded-full border border-border bg-surface px-5 text-[14px] font-medium text-foreground transition hover:border-ring hover:bg-surface-elevated"
            >
              <GoogleGlyph />
              <span>Continue with Google</span>
            </a>
            <a
              href="/v1/auth/keycloak/start"
              className="inline-flex h-11 items-center justify-center gap-2.5 rounded-full border border-border bg-surface px-5 text-[14px] font-medium text-foreground transition hover:border-ring hover:bg-surface-elevated"
            >
              <KeycloakGlyph />
              <span>Continue with Keycloak</span>
            </a>
          </div>

          {error && (
            <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {prettyError(error)}
            </p>
          )}

          <p className="mt-5 text-[12px] text-muted-foreground/80">
            Sign in with your workspace account. Tokens are issued by xyne and
            never leave this app.
          </p>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-3 text-[11px] text-muted-foreground">
        <div className="mx-auto flex max-w-md items-center justify-between">
          <span>ui2 · workspace AI</span>
          <span className="font-mono">v0.0.1</span>
        </div>
      </footer>
    </div>
  )
}

function prettyError(code: string): string {
  switch (code) {
    case "keycloak_unavailable":
      return "Keycloak isn't reachable right now. Try Google, or contact an admin."
    case "keycloak_failed":
      return "Keycloak sign-in failed. Please try again."
    case "workspace_mismatch":
      return "This account belongs to a different workspace."
    case "workspace_not_found":
      return "No workspace exists for that email's domain. An admin needs to provision one in xyne first."
    default:
      return decodeURIComponent(code)
  }
}
