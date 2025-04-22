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
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { Loader2, Github } from "lucide-react"

interface MarkdownProcessorProps {
  isAdmin?: boolean
}

export const MarkdownProcessor = ({
  isAdmin = false,
}: MarkdownProcessorProps) => {
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [result, setResult] = useState<any>(null)
  const [githubUrl, setGithubUrl] = useState<string>("")
  const [excludedFolders, setExcludedFolders] = useState<string>("")
  const [processingStatus, setProcessingStatus] = useState<string>("")

  const handleGithubSubmit = async () => {
    if (!githubUrl) {
      toast({
        title: "Error",
        description: "Please provide a GitHub repository URL",
        variant: "destructive",
      })
      return
    }

    // Extract owner and repo from GitHub URL
    const githubUrlPattern = /github\.com\/([^\/]+)\/([^\/]+)/
    const match = githubUrl.match(githubUrlPattern)

    if (!match) {
      toast({
        title: "Error",
        description:
          "Invalid GitHub repository URL. Please use the format: https://github.com/owner/repo",
        variant: "destructive",
      })
      return
    }

    const [, owner, repo] = match
    // Convert excluded folders string to array and clean it up
    const excludedFoldersArray = excludedFolders
      .split(",")
      .map((folder) => folder.trim())
      .filter((folder) => folder.length > 0)

    setIsProcessing(true)
    setProcessingStatus("Connecting to GitHub repository...")
    try {
      const response = await api.markdown.github.$post({
        json: {
          owner,
          repo,
          docId: `github-${owner}-${repo}-${Date.now()}`,
          embedContent: false,
          excludedFolders: excludedFoldersArray,
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(
          errorData.error || "Failed to process GitHub repository",
        )
      }

      const data = await response.json()
      setResult(data)
      toast({
        title: "Success",
        description: `Successfully processed ${data.filesProcessed} markdown files from the repository`,
      })
    } catch (error) {
      console.error("Error processing GitHub repository:", error)

      // Check if this is a rate limit error
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      if (errorMessage.includes("rate limit")) {
        toast({
          title: "GitHub Rate Limit Exceeded",
          description:
            "GitHub API rate limit exceeded. Please try again later or use a GitHub token.",
          variant: "destructive",
        })
      } else {
        toast({
          title: "Error",
          description: `Failed to process GitHub repository: ${errorMessage}`,
          variant: "destructive",
        })
      }
    } finally {
      setIsProcessing(false)
      setProcessingStatus("")
    }
  }

  return (
    <Card className="w-[600px]">
      <CardHeader>
        <CardTitle>GitHub Repository Processor</CardTitle>
        <CardDescription>
          Process and index markdown files from a GitHub repository
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid w-full gap-1.5">
          <Label htmlFor="github-url">GitHub Repository URL</Label>
          <div className="flex items-center gap-2">
            <Input
              id="github-url"
              placeholder="https://github.com/owner/repo"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              className="flex-1"
            />
            <Button variant="outline" size="icon">
              <Github className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid w-full gap-1.5 mt-4">
          <Label htmlFor="excluded-folders">
            Excluded Folders
            <span className="text-sm text-muted-foreground ml-2">
              (comma-separated)
            </span>
          </Label>
          <Input
            id="excluded-folders"
            placeholder="docs, examples, tests"
            value={excludedFolders}
            onChange={(e) => setExcludedFolders(e.target.value)}
          />
          <p className="text-sm text-muted-foreground mt-1">
            Specify folders to exclude from markdown processing
          </p>
        </div>

        <div className="flex justify-end mt-4">
          <Button
            onClick={handleGithubSubmit}
            disabled={isProcessing || !githubUrl}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {processingStatus || "Processing..."}
              </>
            ) : (
              "Process Repository"
            )}
          </Button>
        </div>

        {result && (
          <div className="mt-4 p-4 border rounded-md bg-muted">
            <h3 className="font-medium mb-2">Processing Result</h3>
            <pre className="text-sm overflow-auto max-h-[200px]">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
