import { Apps } from "shared/types"

export class OAuthModal {
  // private authUrl: string;
  // private connectorId: string;
  private width: number
  private height: number
  private windowRef: Window | null = null
  private intervalId: number | null = null
  private completed = false // Flag to prevent multiple resolve/reject calls
  private logger = console
  private successUrl: string = ""

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
        const authUrl = `/oauth/start`
        this.successUrl = `/oauth/success`
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
      // 1. Check if window is closed
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

      // 2. Try reading the current URL
      let currentUrl: string | undefined
      try {
        currentUrl = this.windowRef?.location?.href
        this.logger.info("Monitoring window")
      } catch (error) {
        // This error happens due to cross-origin issues before the window redirects to your domain
        // It can be safely ignored until the popup window navigates to a URL on your domain
        // If any other error occurs, it should be rejected and error should be thrown
        if (
          !String(error)?.includes(
            "SecurityError: Failed to read a named property 'href' from 'Location'",
          )
        ) {
          this.logger.error(
            error,
            {
              oauthProgress: {
                success: false,
              },
            },
            "Something went wrong. Error occurred",
          )
          reject({
            success: false,
            message: "Something went wrong. Error occurred",
          })
        }
      }

      // 3. If we can read the URL, check if it’s the success URL
      if (currentUrl && currentUrl === this.successUrl) {
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
    }, 500)
  }
}
