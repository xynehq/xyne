import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react"

const THEME_PREFERENCE_EXPLICITLY_SET_KEY = "theme-preference-explicitly-set"
const THEME_KEY = "theme"

type Theme = "light" | "dark"

interface ThemeContextType {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const storedTheme = localStorage.getItem(THEME_KEY) as Theme | null
      if (storedTheme) {
        return storedTheme
      }
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
    }
    return "light" // Default theme for SSR or non-browser environments
  })

  useEffect(() => {
    if (typeof window !== "undefined") {
      document.documentElement.classList.remove("light", "dark")
      document.documentElement.classList.add(theme)
      localStorage.setItem(THEME_KEY, theme)
    }
  }, [theme])

  // Listen to system preference changes and storage events
  useEffect(() => {
    if (typeof window === "undefined") return

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    const handleSystemThemeChange = (e: MediaQueryListEvent) => {
      // Update only if no theme is explicitly set by the user
      if (!localStorage.getItem(THEME_PREFERENCE_EXPLICITLY_SET_KEY)) {
        setTheme(e.matches ? "dark" : "light")
      }
    }

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === THEME_KEY && e.newValue) {
        setTheme(e.newValue as Theme)
      }
    }

    mediaQuery.addEventListener("change", handleSystemThemeChange)
    window.addEventListener("storage", handleStorageChange)

    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange)
      window.removeEventListener("storage", handleStorageChange)
    }
  }, [])

  const toggleTheme = () => {
    setTheme((prevTheme) => {
      const newTheme = prevTheme === "light" ? "dark" : "light"
      // Mark that the user has explicitly set a theme preference
      if (typeof window !== "undefined") {
        localStorage.setItem(THEME_PREFERENCE_EXPLICITLY_SET_KEY, "true")
      }
      return newTheme
    })
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }
  return context
}
