# Use standard CRAN with automatic binary detection
# This will use binaries when available, fallback to source compilation
options(repos = c(CRAN = "https://cran.rstudio.com/"))

# Install essential packages including network support for API calls
install.packages(c(
  "jsonlite",  # JSON parsing/generation
  "httr",      # HTTP requests for API calls
  "curl"       # Basic HTTP/network operations
), dependencies=TRUE, quiet=TRUE)