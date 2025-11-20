import { createFileRoute } from "@tanstack/react-router"
import { Sidebar } from "@/components/Sidebar"
import { useState, useCallback, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import {
  Upload,
  FileAudio,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
} from "lucide-react"
import { api } from "@/api"

export const Route = createFileRoute("/_authenticated/transcription")({
  component: TranscriptionPage,
  errorComponent: () => <div>Error loading transcription page</div>,
  loader: async ({ context }) => {
    return {
      user: context.user,
      workspace: context.workspace,
    }
  },
})

type JobStatus =
  | "idle"
  | "uploading"
  | "queued"
  | "processing"
  | "completed"
  | "failed"

type OutputFormat = "json" | "txt" | "srt" | "all"
type WhisperModel = "turbo" | "large"

interface TranscriptionResult {
  json?: {
    text: string
    segments: Array<{
      speaker: string
      text: string
      start: number
      end: number
    }>
    speakers: string[]
    language: string
  }
  txt?: string
  srt?: string
}

function TranscriptionPage() {
  const { user } = Route.useLoaderData()

  // Form state
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [whisperModel, setWhisperModel] = useState<WhisperModel>("turbo")
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("json")
  const [numSpeakers, setNumSpeakers] = useState<number | undefined>(undefined)

  // Job state
  const [jobStatus, setJobStatus] = useState<JobStatus>("idle")
  const [jobId, setJobId] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TranscriptionResult | null>(null)

  // Polling refs
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      // Cleanup on unmount
      clearPolling()
    },
    [clearPolling],
  )

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file) {
        const validTypes = ["audio/", "video/"]
        if (validTypes.some((type) => file.type.startsWith(type))) {
          setSelectedFile(file)
          setError(null)
          setResult(null)
          setJobId(null)
          setJobStatus("idle")
        } else {
          setError("Please select a valid audio or video file")
          setSelectedFile(null)
        }
      }
    },
    [],
  )

  const uploadFile = async (file: File): Promise<string> => {
    const formData = new FormData()
    formData.append("file", file)

    const response = await fetch(`${api}/files/upload-simple`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("access_token")}`,
      },
      body: formData,
    })

    if (!response.ok) {
      let message = "File upload failed"
      try {
        const data = await response.json()
        if (data?.message) message = data.message
      } catch {
        // ignore JSON parse errors
      }
      throw new Error(message)
    }

    const data = await response.json()
    return data.url
  }

  const pollJobStatus = useCallback(
    (jobId: string) => {
      clearPolling()

      const intervalId = setInterval(async () => {
        try {
          const response = await fetch(`${api}/asr/job-status?jobId=${jobId}`, {
            headers: {
              Authorization: `Bearer ${localStorage.getItem("access_token")}`,
            },
          })

          if (!response.ok) {
            throw new Error("Failed to fetch job status")
          }

          const data = await response.json()

          if (data.status === "completed") {
            clearPolling()
            setJobStatus("completed")
            setResult(data.outputs ?? null)
          } else if (data.status === "failed") {
            clearPolling()
            setJobStatus("failed")
            setError(data.error || "Transcription failed")
          } else if (data.status === "active") {
            setJobStatus("processing")
          }
        } catch (err) {
          clearPolling()
          setJobStatus("failed")
          setError(
            err instanceof Error
              ? err.message
              : "Failed to check job status",
          )
        }
      }, 3000)

      pollIntervalRef.current = intervalId

      // Hard timeout after 30 minutes
      const timeoutId = setTimeout(() => {
        clearPolling()
        setJobStatus("failed")
        setError("Transcription timed out. Please try again.")
      }, 30 * 60 * 1000)

      pollTimeoutRef.current = timeoutId
    },
    [clearPolling],
  )

  const handleSubmit = async () => {
    if (!selectedFile) {
      setError("Please select a file first")
      return
    }

    try {
      clearPolling()
      setJobStatus("uploading")
      setError(null)
      setResult(null)
      setJobId(null)
      setUploadProgress(0)

      // Upload file
      const audioUrl = await uploadFile(selectedFile)
      setUploadProgress(50)

      // Start transcription job
      setJobStatus("queued")
      const response = await fetch(`${api}/asr/transcribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("access_token")}`,
        },
        body: JSON.stringify({
          audioUrl,
          whisperModel,
          refineWithLLM: true,
          outputFormat,
          numSpeakers: numSpeakers || undefined,
          multilingual: true,
        }),
      })

      if (!response.ok) {
        let message = "Failed to start transcription"
        try {
          const data = await response.json()
          if (data?.message) message = data.message
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(message)
      }

      const data = await response.json()
      setJobId(data.jobId)
      setUploadProgress(100)

      // Start polling for job status
      pollJobStatus(data.jobId)
    } catch (err) {
      clearPolling()
      setJobStatus("failed")
      setError(err instanceof Error ? err.message : "An error occurred")
    }
  }

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  const downloadResult = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const isJobIdleLike =
    jobStatus === "idle" || jobStatus === "completed" || jobStatus === "failed"

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink}
        role={user?.role}
        isAgentMode={false}
      />

      <div className="flex-1 flex flex-col h-full md:ml-[52px] ml-0 overflow-y-auto">
        <div className="flex-1 p-6 md:p-8">
          <div className="max-w-5xl mx-auto space-y-6">
            {/* Header */}
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold text-[#191919] dark:text-[#F1F3F4]">
                Audio Transcription
              </h1>
              <p className="text-sm text-[#626F86] dark:text-[#B8BFC8]">
                Upload audio files for automated transcription with speaker
                diarization and AI refinement
              </p>
            </div>

            {/* Upload Card */}
            <Card className="border-[#D7E0E9] dark:border-gray-700 shadow-sm">
              <CardHeader className="border-b border-[#E5E7EB] dark:border-gray-700">
                <CardTitle className="text-lg font-semibold text-[#191919] dark:text-[#F1F3F4]">
                  Upload Audio File
                </CardTitle>
                <CardDescription className="text-sm text-[#626F86] dark:text-[#B8BFC8]">
                  Select an audio or video file to transcribe
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-6">
                {/* File Upload */}
                <div className="border-2 border-dashed border-[#D7E0E9] dark:border-gray-600 rounded-lg p-8 text-center hover:border-[#5865F2] dark:hover:border-[#5865F2] transition-colors bg-[#F7F9FB] dark:bg-[#2A2A2A]">
                  <input
                    type="file"
                    accept="audio/*,video/*"
                    onChange={handleFileSelect}
                    className="hidden"
                    id="file-upload"
                    disabled={!isJobIdleLike}
                  />
                  <label
                    htmlFor="file-upload"
                    className="cursor-pointer flex flex-col items-center space-y-2"
                  >
                    {selectedFile ? (
                      <>
                        <FileAudio className="h-12 w-12 text-[#5865F2]" />
                        <p className="font-medium text-[#191919] dark:text-[#F1F3F4]">
                          {selectedFile.name}
                        </p>
                        <p className="text-sm text-[#626F86] dark:text-[#B8BFC8]">
                          {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                      </>
                    ) : (
                      <>
                        <Upload className="h-12 w-12 text-[#626F86] dark:text-[#B8BFC8]" />
                        <p className="font-medium text-[#191919] dark:text-[#F1F3F4]">
                          Click to upload audio file
                        </p>
                        <p className="text-sm text-[#626F86] dark:text-[#B8BFC8]">
                          Supports MP3, WAV, M4A, and more
                        </p>
                      </>
                    )}
                  </label>
                </div>

                {/* Configuration */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                  {/* Whisper Model */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-[#191919] dark:text-[#F1F3F4]">
                      Whisper Model
                    </Label>
                    <Select
                      value={whisperModel}
                      onValueChange={(val: WhisperModel) =>
                        setWhisperModel(val)
                      }
                    >
                      <SelectTrigger className="border-[#D7E0E9] dark:border-gray-600">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="turbo">
                          Turbo (recommended)
                        </SelectItem>
                        <SelectItem value="large">
                          Large (most accurate)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Output Format */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-[#191919] dark:text-[#F1F3F4]">
                      Output Format
                    </Label>
                    <Select
                      value={outputFormat}
                      onValueChange={(val: OutputFormat) =>
                        setOutputFormat(val)
                      }
                    >
                      <SelectTrigger className="border-[#D7E0E9] dark:border-gray-600">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="json">JSON</SelectItem>
                        <SelectItem value="txt">Text</SelectItem>
                        <SelectItem value="srt">SRT Subtitles</SelectItem>
                        <SelectItem value="all">All Formats</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Number of Speakers */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-[#191919] dark:text-[#F1F3F4]">
                      Number of Speakers
                    </Label>
                    <Select
                      value={numSpeakers?.toString() || "auto"}
                      onValueChange={(val) =>
                        setNumSpeakers(
                          val === "auto" ? undefined : parseInt(val, 10),
                        )
                      }
                    >
                      <SelectTrigger className="border-[#D7E0E9] dark:border-gray-600">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto Detect</SelectItem>
                        <SelectItem value="1">1 Speaker</SelectItem>
                        <SelectItem value="2">2 Speakers</SelectItem>
                        <SelectItem value="3">3 Speakers</SelectItem>
                        <SelectItem value="4">4 Speakers</SelectItem>
                        <SelectItem value="5">5+ Speakers</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Submit Button */}
                <Button
                  onClick={handleSubmit}
                  disabled={!selectedFile || !isJobIdleLike}
                  className="w-full bg-white dark:bg-[#2A2A2A] border-2 border-[#D7E0E9] dark:border-gray-600 hover:bg-[#F7F9FB] dark:hover:bg-gray-800 text-[#191919] dark:text-[#F1F3F4] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  size="lg"
                >
                  {jobStatus === "uploading" && (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Uploading...
                    </>
                  )}
                  {jobStatus === "queued" && (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      In Queue...
                    </>
                  )}
                  {jobStatus === "processing" && (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Processing...
                    </>
                  )}
                  {isJobIdleLike && "Start Transcription"}
                </Button>
              </CardContent>
            </Card>

            {/* Progress/Status Card */}
            {jobStatus !== "idle" && (
              <Card className="border-[#D7E0E9] dark:border-gray-700 shadow-sm">
                <CardHeader className="border-b border-[#E5E7EB] dark:border-gray-700">
                  <CardTitle className="flex items-center gap-2 text-lg font-semibold text-[#191919] dark:text-[#F1F3F4]">
                    {jobStatus === "completed" && (
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-500" />
                    )}
                    {jobStatus === "failed" && (
                      <XCircle className="h-5 w-5 text-red-600 dark:text-red-500" />
                    )}
                    {(jobStatus === "uploading" ||
                      jobStatus === "queued" ||
                      jobStatus === "processing") && (
                      <Loader2 className="h-5 w-5 animate-spin text-[#5865F2]" />
                    )}
                    {jobStatus === "uploading" && "Uploading File"}
                    {jobStatus === "queued" && "Job Queued"}
                    {jobStatus === "processing" && "Transcribing Audio"}
                    {jobStatus === "completed" && "Transcription Complete"}
                    {jobStatus === "failed" && "Transcription Failed"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  {jobStatus === "uploading" && (
                    <Progress value={uploadProgress} className="w-full" />
                  )}

                  {error && (
                    <div className="flex items-center gap-2 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                      <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {error}
                      </p>
                    </div>
                  )}

                  {jobId && (
                    <p className="text-sm text-[#626F86] dark:text-[#B8BFC8]">
                      Job ID:{" "}
                      <code className="bg-[#F7F9FB] dark:bg-[#2A2A2A] px-2 py-1 rounded text-[#191919] dark:text-[#F1F3F4] font-mono text-xs">
                        {jobId}
                      </code>
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Results Card */}
            {result && jobStatus === "completed" && (
              <Card className="border-[#D7E0E9] dark:border-gray-700 shadow-sm">
                <CardHeader className="border-b border-[#E5E7EB] dark:border-gray-700">
                  <CardTitle className="text-lg font-semibold text-[#191919] dark:text-[#F1F3F4]">
                    Transcription Results
                  </CardTitle>
                  <CardDescription className="text-sm text-[#626F86] dark:text-[#B8BFC8]">
                    {result.json &&
                      `Detected ${result.json.speakers.length} speaker(s): ${result.json.speakers.join(
                        ", ",
                      )}`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-6">
                  {/* Download Buttons */}
                  <div className="flex flex-wrap gap-2">
                    {result.json && (
                      <Button
                        variant="outline"
                        className="border-[#D7E0E9] dark:border-gray-600 hover:bg-[#F7F9FB] dark:hover:bg-gray-800"
                        onClick={() =>
                          downloadResult(
                            JSON.stringify(result.json, null, 2),
                            "transcript.json",
                          )
                        }
                      >
                        Download JSON
                      </Button>
                    )}
                    {result.txt && (
                      <Button
                        variant="outline"
                        className="border-[#D7E0E9] dark:border-gray-600 hover:bg-[#F7F9FB] dark:hover:bg-gray-800"
                        onClick={() =>
                          result.txt &&
                          downloadResult(result.txt, "transcript.txt")
                        }
                      >
                        Download TXT
                      </Button>
                    )}
                    {result.srt && (
                      <Button
                        variant="outline"
                        className="border-[#D7E0E9] dark:border-gray-600 hover:bg-[#F7F9FB] dark:hover:bg-gray-800"
                        onClick={() =>
                          result.srt &&
                          downloadResult(result.srt, "transcript.srt")
                        }
                      >
                        Download SRT
                      </Button>
                    )}
                  </div>

                  {/* Transcript Preview */}
                  {result.json && (
                    <div className="border border-[#D7E0E9] dark:border-gray-700 rounded-lg p-4 max-h-96 overflow-y-auto space-y-3 bg-[#F7F9FB] dark:bg-[#2A2A2A]">
                      <h3 className="text-sm font-semibold text-[#191919] dark:text-[#F1F3F4] mb-2">
                        Transcript Preview
                      </h3>
                      {result.json.segments.map((segment, idx) => (
                        <div
                          key={idx}
                          className="space-y-1 pb-2 border-b border-[#E5E7EB] dark:border-gray-700 last:border-0"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[#5865F2]">
                              {segment.speaker}
                            </span>
                            <span className="text-xs text-[#626F86] dark:text-[#B8BFC8]">
                              {formatTime(segment.start)} -{" "}
                              {formatTime(segment.end)}
                            </span>
                          </div>
                          <p className="text-sm text-[#191919] dark:text-[#E3E5E8] pl-4">
                            {segment.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
