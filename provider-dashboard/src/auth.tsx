import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react"
import * as api from "./api"

interface User {
  email: string
  name: string
}

interface AuthState {
  token: string | null
  user: User | null
  workspaceId: string | null
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name: string, workspaceName: string) => Promise<void>
  logout: () => void
  isAuthenticated: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const token = localStorage.getItem("provider_token")
    const userStr = localStorage.getItem("provider_user")
    const workspaceId = localStorage.getItem("provider_workspace_id")
    return {
      token,
      user: userStr ? JSON.parse(userStr) : null,
      workspaceId,
    }
  })

  const setAuth = useCallback((token: string, user: User, workspaceId: string) => {
    localStorage.setItem("provider_token", token)
    localStorage.setItem("provider_user", JSON.stringify(user))
    localStorage.setItem("provider_workspace_id", workspaceId)
    setState({ token, user, workspaceId })
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem("provider_token")
    localStorage.removeItem("provider_user")
    localStorage.removeItem("provider_workspace_id")
    setState({ token: null, user: null, workspaceId: null })
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login({ email, password })
    setAuth(res.token, res.user, res.workspace_id)
  }, [setAuth])

  const signup = useCallback(async (email: string, password: string, name: string, workspaceName: string) => {
    const res = await api.signup({ email, password, name, workspace_name: workspaceName })
    setAuth(res.token, res.user, res.workspace_id)
  }, [setAuth])

  // Verify token on mount
  useEffect(() => {
    if (state.token) {
      api.getMe().catch(() => {
        logout()
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        signup,
        logout,
        isAuthenticated: !!state.token,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
