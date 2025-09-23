  export const RBI_CONFIG = {
    BASE_URL: 'https://rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx',
    TARGET_YEAR: '2025',
    TARGET_MONTH: 'January',
    DOWNLOADS_FOLDER: './downloads/rbi-circulars',
    TIMEOUT: 30000,
    DOWNLOAD_TIMEOUT: 60000,
    HEADLESS: false,
    USE_SYSTEM_CHROME: true, // Add this line
  } as const;