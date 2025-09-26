  export const RBI_CONFIG = {
    BASE_URL: 'https://rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx',
    TARGET_YEARS: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    TARGET_MONTH: 'January',
    DOWNLOADS_FOLDER: './downloads/rbi-circulars/allCirculars',
        TARGET_DEPARTMENT: 'Department of Payment and Settlement Systems', 
    TIMEOUT: 30000,
    DOWNLOAD_TIMEOUT: 60000,
    HEADLESS: false,
    USE_SYSTEM_CHROME: true, 
  } as const;