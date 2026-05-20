/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* ── Legacy shadcn aliases (preserved) ───────────────────────── */
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",

        surface: {
          DEFAULT: "hsl(var(--surface-default))",
          page: "hsl(var(--surface-page))",
          hover: "hsl(var(--surface-hover))",
          elevated: "hsl(var(--surface-elevated))",
          muted: "hsl(var(--surface-muted))",
          disabled: "hsl(var(--surface-disabled))",
          highlight: "hsl(var(--surface-highlight))",
          selected: "hsl(var(--surface-selected))",
          inverse: "hsl(var(--surface-inverse))",
          information: "hsl(var(--surface-information))",
          brand: {
            DEFAULT: "hsl(var(--surface-brand))",
            subtle: "hsl(var(--surface-brand-subtle))",
            hover: "hsl(var(--surface-brand-hover))",
            pressed: "hsl(var(--surface-brand-pressed))",
          },
          success: {
            DEFAULT: "hsl(var(--surface-success))",
            subtle: "hsl(var(--surface-success-subtle))",
            hover: "hsl(var(--surface-success-hover))",
            pressed: "hsl(var(--surface-success-pressed))",
          },
          warning: {
            DEFAULT: "hsl(var(--surface-warning))",
            subtle: "hsl(var(--surface-warning-subtle))",
            hover: "hsl(var(--surface-warning-hover))",
            pressed: "hsl(var(--surface-warning-pressed))",
          },
          error: {
            DEFAULT: "hsl(var(--surface-error))",
            subtle: "hsl(var(--surface-error-subtle))",
            hover: "hsl(var(--surface-error-hover))",
            pressed: "hsl(var(--surface-error-pressed))",
          },
        },

        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          border: "hsl(var(--sidebar-border))",
        },
        bubble: {
          assistant: "hsl(var(--assistant-bg))",
          user: "hsl(var(--user-bg))",
        },

        /* ── Figma semantic tokens ───────────────────────────────────── */
        brand: {
          DEFAULT: "hsl(var(--surface-brand))",
          subtle: "hsl(var(--surface-brand-subtle))",
          hover: "hsl(var(--surface-brand-hover))",
          pressed: "hsl(var(--surface-brand-pressed))",
          fg: "hsl(var(--text-brand))",
          "fg-hover": "hsl(var(--text-brand-hover))",
        },
        success: {
          DEFAULT: "hsl(var(--surface-success))",
          subtle: "hsl(var(--surface-success-subtle))",
          hover: "hsl(var(--surface-success-hover))",
          pressed: "hsl(var(--surface-success-pressed))",
          fg: "hsl(var(--text-success))",
        },
        warning: {
          DEFAULT: "hsl(var(--surface-warning))",
          subtle: "hsl(var(--surface-warning-subtle))",
          hover: "hsl(var(--surface-warning-hover))",
          pressed: "hsl(var(--surface-warning-pressed))",
          fg: "hsl(var(--text-warning))",
        },
        error: {
          DEFAULT: "hsl(var(--surface-error))",
          subtle: "hsl(var(--surface-error-subtle))",
          hover: "hsl(var(--surface-error-hover))",
          pressed: "hsl(var(--surface-error-pressed))",
          fg: "hsl(var(--text-error))",
        },
        info: {
          DEFAULT: "hsl(var(--surface-information))",
          fg: "hsl(var(--text-information))",
        },

        /* Foreground / text tokens (use as text-fg-*) */
        fg: {
          DEFAULT: "hsl(var(--text-default))",
          subtle: "hsl(var(--text-subtle))",
          muted: "hsl(var(--text-muted))",
          disabled: "hsl(var(--text-disabled))",
          "on-action": "hsl(var(--text-on-action))",
          "on-disabled": "hsl(var(--text-on-disabled))",
        },

        /* Icon tokens (use as text-icon-* on svg/icon elements) */
        icon: {
          DEFAULT: "hsl(var(--icon-default))",
          disabled: "hsl(var(--icon-disabled))",
          "on-action": "hsl(var(--icon-on-action))",
          "on-disabled": "hsl(var(--icon-on-disabled))",
          brand: "hsl(var(--icon-brand))",
          "brand-hover": "hsl(var(--icon-brand-hover))",
          success: "hsl(var(--icon-success))",
          warning: "hsl(var(--icon-warning))",
          error: "hsl(var(--icon-error))",
          info: "hsl(var(--icon-information))",
        },
      },

      /* Border-color tokens (use as border-line-*) */
      borderColor: {
        line: {
          DEFAULT: "hsl(var(--border-default))",
          outline: "hsl(var(--border-outline))",
          bold: "hsl(var(--border-bold))",
          subtle: "hsl(var(--border-subtle))",
          disabled: "hsl(var(--border-disabled))",
          brand: "hsl(var(--border-brand))",
          "brand-hover": "hsl(var(--border-brand-hover))",
          success: "hsl(var(--border-success))",
          warning: "hsl(var(--border-warning))",
          error: "hsl(var(--border-error))",
        },
      },

      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 6px)",
      },
      fontFamily: {
        display: [
          '"Instrument Serif"',
          "ui-serif",
          "Georgia",
          "Cambria",
          "Times New Roman",
          "serif",
        ],
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.7" },
          "50%": { opacity: "1" },
        },
        slideUpIn: {
          "0%": { opacity: "0", transform: "translateY(100%)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideUpOut: {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(-100%)" },
        },
      },
      animation: {
        "fade-up": "fadeUp 320ms cubic-bezier(0.2, 0.7, 0.1, 1) both",
        "fade-in": "fadeIn 180ms ease-out both",
        "scale-in": "scaleIn 200ms cubic-bezier(0.2, 0.9, 0.3, 1) both",
        breathe: "breathe 2.4s ease-in-out infinite",
        "slide-up-in": "slideUpIn 280ms cubic-bezier(0.22, 0.9, 0.3, 1) both",
        "slide-up-out": "slideUpOut 280ms cubic-bezier(0.22, 0.9, 0.3, 1) both",
      },
    },
  },
  plugins: [],
}
