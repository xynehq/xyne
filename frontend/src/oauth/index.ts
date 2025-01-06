import { Apps } from "shared/types"

const authUrl = `${import.meta.env.VITE_API_BASE_URL}/oauth/start`
const successUrl = `${import.meta.env.VITE_API_BASE_URL}/oauth?success=true}`
export class OAuthModal {
  // private authUrl: string;
  // private connectorId: string;
  private width: number
  private height: number
  private windowRef: Window | null = null
  private intervalId: number | null = null
  private completed = false // Flag to prevent multiple resolve/reject calls
  private logger = console

  constructor(
    // connectorId: string;
    width?: number,
    height?: number,
  ) {
    // this.connectorId = config.connectorId;
    this.width = width || 600
    this.height = height || 700
  }

  public startAuth(app: Apps) {
    return new Promise((resolve, reject) => {
      try {
        //clientLog({currentApp: app}, 'Starting OAuth')
        this.logger.info({ currentApp: app }, "Starting OAuth")
        this.openAuthWindow(`${authUrl}?app=${app}`)
        this.monitorWindow(resolve, reject)
      } catch (error) {
        this.logger.error(error, `Error starting OAuth: ${error}`)
        reject(error)
      }
    })
  }

  private openAuthWindow(url: string) {
    const left = window.screen.width / 2 - this.width / 2
    const top = window.screen.height / 2 - this.height / 2
    this.logger.info("Opened OAuth Window")
    const features = `width=${this.width},height=${this.height},top=${top},left=${left},status=no,menubar=no,toolbar=no`

    this.windowRef = window.open(url, "_blank", features)

    if (!this.windowRef) {
      this.logger.error("Popup blocked. User had popups blocked")
      throw new Error("Popup blocked. Please allow popups and try again.")
    }
  }

  private monitorWindow(
    resolve: (value: { success: boolean; message: string }) => void,
    reject: (reason?: any) => void,
  ) {
    this.intervalId = window.setInterval(() => {
      if (this.completed) return // If already resolved/rejected, stop further actions

      if (this.windowRef && this.windowRef.closed) {
        window.clearInterval(this.intervalId!)
        this.intervalId = null

        if (!this.completed) {
          this.completed = true // Mark as completed
          reject({
            success: false,
            message: "Authentication window was closed before completion.",
          })
        }
      }

      try {
        const currentUrl = this.windowRef?.location.href
        this.logger.info("Monitoring window")
        if (currentUrl && currentUrl === successUrl) {
          // When the popup window reaches the success URL, stop monitoring
          window.clearInterval(this.intervalId!)
          this.intervalId = null

          if (!this.completed) {
            this.completed = true // Mark as completed
            this.windowRef?.close()
            this.logger.info(
              {
                oauthProgress: {
                  success: true,
                },
              },
              "Oauth Successful",
            )
            resolve({ success: true, message: "OAuth successful!" })
          }
        }
      } catch (error) {
        // This error happens due to cross-origin issues before the window redirects to your domain
        // It can be safely ignored until the popup window navigates to a URL on your domain
        this.logger.error(
          error,
          {
            oauthProgress: {
              success: false,
            },
          },
          "Authentication window was closed before completion.",
        )
        reject({
          success: false,
          message: "Authentication window was closed before completion.",
        })
      }
    }, 500) // Check every 500ms
  }
}
