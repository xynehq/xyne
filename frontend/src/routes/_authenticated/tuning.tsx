import { Sidebar } from "@/components/Sidebar"
import { Button } from "@/components/ui/button"
import { api, wsClient } from "@/api"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { useToast } from "@/hooks/use-toast"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export const Route = createFileRoute("/_authenticated/tuning")({
  component: TuningPage, // Changed component name
})

type JobStatus = "idle" | "running" | "success" | "error"

// Define type for the dataset object based on backend response
interface DatasetInfo {
  filename: string
  jobId: string
  params: {
    s?: number // numSamples
    // Add other parsed params here if needed
  }
}

export default function TuningPage() {
  // Changed function name to match export default and component prop
  const [jobStatus, setJobStatus] = useState<JobStatus>("idle")
  const [jobMessage, setJobMessage] = useState<string>("")
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobProgress, setJobProgress] = useState<number>(0) // State for progress percentage
  const [progressStatus, setProgressStatus] = useState<string>("") // State for the status text from progress message
  const socketRef = useRef<WebSocket | null>(null)
  const { toast } = useToast()
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]) // Updated state type
  const [numSamples, setNumSamples] = useState<number>(100) // State for sample count input, default 100

  // Assuming user and workspace are available from the route context
  // You might need to adjust how user is obtained if it's not via context
  const { user } = Route.useRouteContext()

  // Fetch datasets when the component mounts
  useEffect(() => {
    const fetchDatasets = async () => {
      try {
        const res = await api.tuning.datasets.$get()
        if (res.ok) {
          const data = await res.json()
          setDatasets(data.datasets || []) // Assuming backend returns { datasets: DatasetInfo[] }
        } else {
          const errorData = await res
            .json()
            .catch(() => ({ message: "Failed to fetch datasets" }))
          toast({
            title: "Failed to fetch datasets",
            description: errorData.message,
            variant: "destructive",
          })
        }
      } catch (error) {
        console.error("Error fetching datasets:", error)
        toast({
          title: "Error fetching datasets",
          description: error instanceof Error ? error.message : "Unknown error",
          variant: "destructive",
        })
      }
    }

    fetchDatasets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Added eslint-disable for toast dependency

  useEffect(() => {
    // Only establish WebSocket connection if we have a jobId and it's running
    if (jobId && jobStatus === "running" && !socketRef.current) {
      console.log(`Attempting to open WebSocket for job ID: ${jobId}`)
      // Corrected: Target the specific tuning WebSocket endpoint
      const socket = wsClient.api.v1.tuning.ws[":jobId"].$ws({
        param: { jobId: jobId }, // Pass jobId as path parameter
        // query: { context: "tuning" }, // Query params might still be useful if needed
      })
      socketRef.current = socket

      socket.addEventListener("open", () => {
        console.info(`Tuning WebSocket opened for job ${jobId}`)
        // Maybe request initial status or just wait for updates
      })

      socket.addEventListener("message", (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)
          console.log("Received WebSocket message:", data)

          // Check for structured progress messages first
          if (data.status === "generating" || data.status === "optimizing") {
            console.log("Received Progress message:", data)
            setProgressStatus(data.status)
            setJobMessage(data.message || "Processing...")
            setJobProgress(data.progress ?? jobProgress) // Update progress, keep old if null
            // Update main job status if needed, e.g., setJobStatus("running")?
          } else if (data.status === "generated") {
            // Dataset generated, optimization starting
            console.log("Received Generated message:", data)
            setProgressStatus(data.status)
            setJobMessage(data.message || "Dataset generated.")
            // Progress might reset here or wait for optimizing status
            setJobProgress(0)
            // Keep jobStatus as "running" as optimization follows
          } else if (data.event === "tuning:progress") {
            // Fallback for old/simple string progress
            console.log("Received simple progress string:", data.message)
            try {
              const inner = JSON.parse(data.message)
              setProgressStatus(inner.status)
              setJobMessage(inner.message ?? "Processing...")
              setJobProgress(inner.progress ?? 0)
            } catch {
              setJobMessage(data.message ?? "Processing...")
            }
            // Cannot set percentage from simple message
          } else if (data.event === "tuning:complete") {
            console.log("Received WebSocket message:", data)
            setJobStatus("success")
            // Final message comes from the 'result' field in the optimization step
            const finalMsg = data.result
              ? `Optimization complete. Best alpha: ${data.result.bestAlpha?.toFixed(2)} (MRR: ${data.result.bestMrr?.toFixed(4)}, NDCG@10: ${data.result.bestNdcg?.toFixed(4)})`
              : data.message || "Evaluation completed successfully!"
            setJobMessage(finalMsg)
            setJobProgress(100) // Ensure progress is 100%
            toast({ title: "Evaluation complete." })
            socketRef.current?.close(1000, "Job finished") // Close WebSocket
            socketRef.current = null
          } else if (data.event === "tuning:error") {
            setJobStatus("error")
            setJobMessage(`Evaluation failed: ${data.error || "Unknown error"}`)
            toast({
              title: "Evaluation failed.",
              description: data.error || "Unknown error",
              variant: "destructive",
            })
            socketRef.current?.close(1000, "Job error") // Close WebSocket
            socketRef.current = null
          } else if (data.message) {
            // Fallback for simple status messages
            setJobMessage(data.message)
          }
        } catch (error) {
          console.error("Error processing WebSocket message:", error)
          // Decide how to handle potentially malformed messages
        }
      })

      socket.addEventListener("close", (event: CloseEvent) => {
        console.info(
          `Tuning WebSocket closed for job ${jobId}. Reason: ${event.reason}, Code: ${event.code}`,
        )
        socketRef.current = null
      })

      socket.addEventListener("error", (error: Event) => {
        console.error(`Tuning WebSocket error for job ${jobId}:`, error)
        setJobStatus("error")
        setJobMessage("WebSocket connection error during evaluation.")
        toast({ title: "WebSocket connection error.", variant: "destructive" })
        socketRef.current = null
      })
    }

    // Cleanup function
    return () => {
      if (
        socketRef.current &&
        socketRef.current.readyState === WebSocket.OPEN
      ) {
        console.log(
          `Closing WebSocket for job ID: ${jobId} on component unmount/cleanup`,
        )
        // Optionally send a message indicating client disconnect if backend handles it
        socketRef.current.close(1000, "Client disconnected")
      }
      socketRef.current = null // Clear ref on cleanup
    }
    // Rerun useEffect if jobId changes or if jobStatus becomes 'running'
  }, [jobId, jobStatus])

  const handleEvaluateClick = async () => {
    if (jobStatus === "running") {
      toast({
        title: "Evaluation is already in progress.",
        variant: "destructive",
      })
      return
    }
    if (numSamples < 1) {
      toast({
        title: "Number of samples must be at least 1.",
        variant: "destructive",
      })
      return
    }
    setJobStatus("running")
    setJobMessage("Starting evaluation...")
    setJobId(null) // Reset previous job ID if any
    toast({ title: "Sending evaluation request..." })

    try {
      // Send numSamples in the request body
      const res = await api.tuning.evaluate.$post({
        json: { numSamples: numSamples },
      })

      if (!res.ok) {
        const errorData = await res
          .json()
          .catch(() => ({ message: "Failed to parse error response" }))
        throw new Error(
          errorData.message || `Server responded with status ${res.status}`,
        )
      }

      const data = await res.json()

      if (!data.jobId) {
        throw new Error("Backend did not return a job ID.")
      }

      setJobId(data.jobId) // Set the jobId to trigger the useEffect for WebSocket
      setJobMessage(
        `Evaluation job started with ID: ${data.jobId}. Waiting for updates...`,
      )
      toast({ title: `Evaluation job started (ID: ${data.jobId}).` })
    } catch (error) {
      console.error("Failed to start evaluation:", error)
      setJobStatus("error")
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error"
      setJobMessage(`Failed to start evaluation: ${errorMessage}`)
      toast({
        title: "Failed to start evaluation",
        description: errorMessage,
        variant: "destructive",
      })
      setJobId(null) // Ensure jobId is null on failure
      if (socketRef.current) {
        socketRef.current.close(1000, "API call failed")
        socketRef.current = null
      }
    }
  }

  // Handle tuning a specific dataset
  const handleTuneDatasetClick = async (datasetFilename: string) => {
    if (jobStatus === "running") {
      toast({
        title: "Another job is already in progress.",
        variant: "destructive",
      })
      return
    }
    setJobStatus("running")
    setJobMessage(`Starting tuning for dataset: ${datasetFilename}...`)
    setJobId(null) // Reset previous job ID if any
    toast({ title: `Sending tuning request for dataset ${datasetFilename}...` })

    try {
      const res = await api.tuning.tuneDataset.$post({
        json: { datasetFilename },
      })

      if (!res.ok) {
        const errorData = await res
          .json()
          .catch(() => ({ message: "Failed to parse error response" }))
        throw new Error(
          errorData.message || `Server responded with status ${res.status}`,
        )
      }

      const data = await res.json()

      if (!data.jobId) {
        throw new Error("Backend did not return a job ID.")
      }

      setJobId(data.jobId) // Set the jobId to trigger the useEffect for WebSocket
      setJobMessage(
        `Tuning job started with ID: ${data.jobId} for dataset ${datasetFilename}. Waiting for updates...`,
      )
      toast({ title: `Tuning job started (ID: ${data.jobId}).` })
    } catch (error) {
      console.error(
        `Failed to start tuning for dataset ${datasetFilename}:`,
        error,
      )
      setJobStatus("error")
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error"
      setJobMessage(`Failed to start tuning: ${errorMessage}`)
      toast({
        title: "Failed to start tuning",
        description: errorMessage,
        variant: "destructive",
      })
      setJobId(null) // Ensure jobId is null on failure
      if (socketRef.current) {
        socketRef.current.close(1000, "API call failed")
        socketRef.current = null
      }
    }
  }

  // Handle deleting a specific dataset
  const handleDeleteDatasetClick = async (filenameToDelete: string) => {
    // Confirmation is handled by AlertDialog
    console.log(`Attempting to delete dataset: ${filenameToDelete}`)
    try {
      const res = await api.tuning.datasets[":filename"].$delete({
        param: { filename: filenameToDelete },
      })

      if (!res.ok) {
        const errorData = await res
          .json()
          .catch(() => ({ message: "Failed to parse error response" }))
        throw new Error(
          errorData.message || `Server responded with status ${res.status}`,
        )
      }

      const data = await res.json()
      toast({ title: "Dataset Deleted", description: data.message })

      // Remove the dataset from the local state
      setDatasets((currentDatasets) =>
        currentDatasets.filter((ds) => ds.filename !== filenameToDelete),
      )
    } catch (error) {
      console.error(`Failed to delete dataset ${filenameToDelete}:`, error)
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error"
      toast({
        title: "Failed to delete dataset",
        description: errorMessage,
        variant: "destructive",
      })
    }
  }

  return (
    <div className="flex w-full h-full dark:bg-[#1E1E1E]">
      {" "}
      {/* Added wrapper div for layout */}
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />{" "}
      {/* Placed Sidebar here and passed props */}
      <div className="flex flex-col flex-grow h-full ml-[52px] mx-auto w-full max-w-5xl px-4 py-8">
        {" "}
        {/* Added margin to content div */}
        <div className="flex flex-col gap-6">
          <h1 className="text-2xl font-semibold dark:text-gray-100">
            Tune Search Parameters
          </h1>
          <p className="dark:text-gray-300">
            Configure and start an automated evaluation process to find the
            optimal alpha value for your search personalization. This process
            may take several minutes. You will receive updates on its progress
            via WebSocket.
          </p>
          {/* Input for Number of Samples */}
          <div className="flex items-center gap-2 max-w-xs">
            <Label htmlFor="numSamplesInput" className="whitespace-nowrap">
              Number of Samples:
            </Label>
            <Input
              id="numSamplesInput"
              type="number"
              value={numSamples}
              onChange={(e) => setNumSamples(parseInt(e.target.value, 10) || 1)}
              min="1"
              step="1"
              disabled={jobStatus === "running"}
              className="w-24"
            />
          </div>
          <Button
            onClick={handleEvaluateClick}
            disabled={jobStatus === "running"}
            className="w-fit"
          >
            {jobStatus === "running"
              ? "Evaluation Running..."
              : "Start New Evaluation"}
          </Button>

          {/* Display existing datasets */}
          {datasets.length > 0 && (
            <div className="mt-8">
              <h2 className="text-xl font-semibold mb-4 dark:text-gray-100">
                Available Datasets
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dataset Filename</TableHead>
                    <TableHead className="text-center">Samples</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {datasets.map((datasetInfo) => (
                    <TableRow key={datasetInfo.filename}>
                      <TableCell>{datasetInfo.filename}</TableCell>
                      <TableCell className="text-center">
                        {/* Display sample count if available */}
                        {datasetInfo.params.s ?? "N/A"}
                      </TableCell>
                      <TableCell className="space-x-2">
                        <Button
                          onClick={() =>
                            handleTuneDatasetClick(datasetInfo.filename)
                          }
                          disabled={jobStatus === "running"}
                          variant="outline"
                          size="sm"
                        >
                          Tune This Dataset
                        </Button>
                        {/* Delete Button with Confirmation Dialog */}
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={jobStatus === "running"}
                            >
                              Delete
                            </Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>
                                Are you absolutely sure?
                              </DialogTitle>
                              <DialogDescription>
                                This action cannot be undone. This will
                                permanently delete the dataset file
                                <code className="mx-1 font-mono bg-muted dark:bg-slate-700 p-1 rounded">
                                  {datasetInfo.filename}
                                </code>
                                .
                              </DialogDescription>
                            </DialogHeader>
                            <DialogFooter className="mt-4">
                              <DialogClose asChild>
                                <Button variant="outline">Cancel</Button>
                              </DialogClose>
                              <Button
                                variant="destructive"
                                onClick={() =>
                                  handleDeleteDatasetClick(datasetInfo.filename)
                                }
                              >
                                Continue
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {jobMessage && (
            <div className="mt-6 p-4 border dark:border-slate-700 rounded bg-muted dark:bg-slate-800 text-muted-foreground dark:text-gray-300">
              <p>Status: {jobStatus}</p>
              <p className="mb-2">{jobMessage}</p>
              {jobId && <p>Job ID: {jobId}</p>}
              {/* Show Progress bar when running */}
              {(jobStatus === "running" ||
                progressStatus === "generating" ||
                progressStatus === "optimizing") && (
                <div className="mt-2">
                  <Progress value={jobProgress} className="w-full" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
