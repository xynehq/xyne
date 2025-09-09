import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Copy, Key, Loader2 } from "lucide-react"
import { errorComponent } from "@/components/error"
import { authFetch } from "@/utils/authFetch"

interface PublicApiKeyResponse {
  data: {
    key: string
  }
}

const ApiKeyGenerator = () => {
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [publicApiKeyData, setPublicApiKeyData] =
    useState<PublicApiKeyResponse | null>(null)
  const { toast } = useToast()

  const generateApiKey = async () => {
    setError(null)
    setIsGenerating(true)

    try {
      const response = await authFetch("/api/v1/admin/workspace/api-key")
      const data = await response.json()

      if (response.ok && !data.error) {
        setPublicApiKeyData(data)
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

  const copyToClipboard = async () => {
    const keyToCopy = publicApiKeyData?.data?.key

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

            <CardDescription className="text-lg">
              Generate a secure API key for your workspace
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            <Button
              onClick={generateApiKey}
              disabled={isGenerating}
              className="w-full"
              size="lg"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  "Retrieving..."
                </>
              ) : (
                <>
                  <Key className="mr-2 h-4 w-4" />
                  Retrieve Public API Key
                </>
              )}
            </Button>

            {/* Error Message */}
            {error && (
              <div className="p-4 border border-destructive/50 bg-destructive/10 text-destructive rounded-md">
                {error}
              </div>
            )}

            {publicApiKeyData && (
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle className="text-xl text-center">
                    🎉 Your Public API Key
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
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
