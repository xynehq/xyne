import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { Copy, Key, Loader2, Clock, Calendar, ChevronDown } from "lucide-react"
import { errorComponent } from "@/components/error"
import { authFetch } from "@/utils/authFetch"

interface ApiKeyResponse {
  apiKey: string
  expiresIn: string
  expirationDays: number
  instructions: string
}

interface PublicApiKeyResponse {
  data: {
    key: string
  }
}

const ApiKeyGenerator = () => {
  const [durationValue, setDurationValue] = useState(1)
  const [durationUnit, setDurationUnit] = useState<
    "minutes" | "hours" | "days"
  >("days")
  const [isGenerating, setIsGenerating] = useState(false)
  const [apiKeyData, setApiKeyData] = useState<ApiKeyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPublicApiKey, setIsPublicApiKey] = useState(true)
  const [publicApiKeyData, setPublicApiKeyData] =
    useState<PublicApiKeyResponse | null>(null)
  const { toast } = useToast()

  const validateDuration = (): string | null => {
    if (!durationValue || durationValue < 1) {
      return "Please enter a valid duration (minimum 1)"
    }

    let expirationDays: number
    switch (durationUnit) {
      case "minutes":
        expirationDays = durationValue / (24 * 60)
        if (durationValue < 1) return "Minimum duration is 1 minute"
        if (durationValue > 43200)
          return "Maximum duration is 30 days (43,200 minutes)"
        break
      case "hours":
        expirationDays = durationValue / 24
        if (durationValue < 1) return "Minimum duration is 1 hour"
        if (durationValue > 720)
          return "Maximum duration is 30 days (720 hours)"
        break
      case "days":
        expirationDays = durationValue
        if (durationValue < 1) return "Minimum duration is 1 day"
        if (durationValue > 30) return "Maximum duration is 30 days"
        break
      default:
        expirationDays = durationValue
    }

    if (expirationDays < 1 / 1440) return "Minimum expiration time is 1 minute"
    if (expirationDays > 30) return "Maximum expiration time is 30 days"

    return null
  }

  const generateApiKey = async () => {
    setError(null)
    setIsGenerating(true)

    try {
      if (isPublicApiKey) {
        // Call public API key endpoint
        const response = await authFetch("/api/v1/admin/workspace/api-key")
        const data = await response.json()

        if (response.ok && !data.error) {
          setPublicApiKeyData(data)
          setApiKeyData(null) // Clear regular API key data
          toast({
            title: "Public API Key Retrieved",
            description: "Your public API key has been retrieved successfully!",
          })
        } else {
          const errorMessage =
            data.message || data.error || "Failed to retrieve public API key"
          setError(errorMessage)
          toast({
            title: "Error",
            description: errorMessage,
            variant: "destructive",
          })
        }
      } else {
        // Regular API key generation
        const validationError = validateDuration()
        if (validationError) {
          setError(validationError)
          setIsGenerating(false)
          return
        }

        // Convert to days for backend
        let expirationDays: number
        switch (durationUnit) {
          case "minutes":
            expirationDays = durationValue / (24 * 60)
            break
          case "hours":
            expirationDays = durationValue / 24
            break
          case "days":
            expirationDays = durationValue
            break
        }

        const response = await authFetch(
          `/api/v1/auth/generate-api-key?expirationDays=${expirationDays}`,
        )
        const data = await response.json()

        if (response.ok && !data.error) {
          setApiKeyData(data)
          setPublicApiKeyData(null) // Clear public API key data
          toast({
            title: "API Key Generated",
            description: "Your API key has been generated successfully!",
          })
        } else {
          const errorMessage =
            data.message || data.error || "Failed to generate API key"
          setError(errorMessage)
          toast({
            title: "Error",
            description: errorMessage,
            variant: "destructive",
          })
        }
      }
    } catch (error) {
      const errorMessage = `Network error: ${error instanceof Error ? error.message : "Unknown error"}`
      setError(errorMessage)
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      })
    } finally {
      setIsGenerating(false)
    }
  }

  const handlePublicApiKeyToggle = (checked: boolean) => {
    setIsPublicApiKey(checked)

    if (!checked) {
      setPublicApiKeyData(null)
      setApiKeyData(null)
    }
  }

  const copyToClipboard = async () => {
    const keyToCopy = isPublicApiKey
      ? publicApiKeyData?.data?.key
      : apiKeyData?.apiKey
    if (!keyToCopy) return

    try {
      await navigator.clipboard.writeText(keyToCopy)
      toast({
        title: "Copied!",
        description: "API key copied to clipboard",
      })
    } catch (error) {
      // Fallback for older browsers
      const textArea = document.createElement("textarea")
      textArea.value = keyToCopy
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand("copy")
      document.body.removeChild(textArea)

      toast({
        title: "Copied!",
        description: "API key copied to clipboard",
      })
    }
  }

  const getMaxValue = () => {
    switch (durationUnit) {
      case "minutes":
        return 43200 // 30 days * 24 hours * 60 minutes
      case "hours":
        return 720 // 30 days * 24 hours
      case "days":
        return 30
      default:
        return 30
    }
  }

  return (
    <div className="min-h-screen bg-background p-6 flex items-center justify-center">
      <div className="w-full max-w-2xl space-y-6">
        <Card>
          <CardHeader className="text-center">
            <div className="flex items-center justify-center mb-2">
              <Key className="h-8 w-8 text-primary mr-2" />
              <CardTitle className="text-3xl font-bold">
                API Key Generator
              </CardTitle>
            </div>
            {!isPublicApiKey && (
              <CardDescription className="text-lg">
                Generate a secure API key to access the Vespa proxy endpoints
                <br />
                <span className="text-sm text-muted-foreground">
                  Expiration range: 1 minute to 30 days
                </span>
              </CardDescription>
            )}
            {isPublicApiKey && (
              <CardDescription className="text-lg">
                Generate a secure API key for your workspace
              </CardDescription>
            )}
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Duration Input - Only show when not public API key */}
            {!isPublicApiKey && (
              <div className="space-y-2">
                <Label htmlFor="duration">Expiration Time</Label>
                <div className="flex gap-2">
                  <Input
                    id="duration"
                    type="number"
                    min="1"
                    max={getMaxValue()}
                    value={durationValue}
                    onChange={(e) =>
                      setDurationValue(parseInt(e.target.value) || 1)
                    }
                    placeholder="Enter duration"
                    className="flex-1"
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="flex-1 h-9 justify-between"
                      >
                        {durationUnit.charAt(0).toUpperCase() +
                          durationUnit.slice(1)}
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setDurationUnit("minutes")}
                      >
                        Minutes
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDurationUnit("hours")}
                      >
                        Hours
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDurationUnit("days")}>
                        Days
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )}

            {/* Public API Key Checkbox */}
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="publicApiKey"
                checked={isPublicApiKey}
                onChange={(e) => handlePublicApiKeyToggle(e.target.checked)}
                style={{
                  width: "16px",
                  height: "16px",
                  accentColor: "hsl(var(--primary))",
                  cursor: "pointer",
                }}
              />
              <Label
                htmlFor="publicApiKey"
                style={{ cursor: "pointer", fontSize: "14px" }}
              >
                Public API Key
              </Label>
            </div>

            {/* Generate Button */}
            <Button
              onClick={generateApiKey}
              disabled={isGenerating}
              className="w-full"
              size="lg"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {isPublicApiKey ? "Retrieving..." : "Generating..."}
                </>
              ) : (
                <>
                  <Key className="mr-2 h-4 w-4" />
                  {isPublicApiKey
                    ? "Retrieve Public API Key"
                    : "Generate API Key"}
                </>
              )}
            </Button>

            {/* Error Message */}
            {error && (
              <div className="p-4 border border-destructive/50 bg-destructive/10 text-destructive rounded-md">
                {error}
              </div>
            )}

            {/* Public API Key Result */}
            {publicApiKeyData && (
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle className="text-xl text-center">
                    🎉 Your Public API Key
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* API Key Display */}
                  <div className="relative">
                    <div className="bg-muted/50 border rounded-lg p-4 font-mono text-sm break-all">
                      {publicApiKeyData.data.key}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={copyToClipboard}
                      className="absolute top-2 right-2"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Regular API Key Result */}
            {apiKeyData && !isPublicApiKey && (
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle className="text-xl text-center">
                    🎉 Your API Key
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* API Key Display */}
                  <div className="relative">
                    <div className="bg-muted/50 border rounded-lg p-4 font-mono text-sm break-all">
                      {apiKeyData.apiKey}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={copyToClipboard}
                      className="absolute top-2 right-2"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Info Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Card>
                      <CardContent className="pt-4">
                        <div className="flex items-center space-x-2">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">Expires In</p>
                            <p className="text-sm text-muted-foreground">
                              {apiKeyData.expiresIn}
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="pt-4">
                        <div className="flex items-center space-x-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">Created At</p>
                            <p className="text-sm text-muted-foreground">
                              {new Date().toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Usage Instructions */}
                  <Card>
                    <CardContent className="pt-4">
                      <h4 className="font-medium mb-2">Usage Instructions</h4>
                      <p className="text-sm text-muted-foreground mb-2">
                        Use this API key in the{" "}
                        <code className="bg-muted px-1 rounded">x-api-key</code>{" "}
                        header for API requests:
                      </p>
                      <div className="bg-muted/50 border rounded p-3 font-mono text-xs">
                        curl -H "x-api-key: YOUR_API_KEY"
                        https://your-api-endpoint.com/api/endpoint
                      </div>
                    </CardContent>
                  </Card>
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authenticated/api-key")({
  component: ApiKeyGenerator,
  errorComponent: errorComponent,
})
