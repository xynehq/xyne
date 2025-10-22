import { useState, useRef, useEffect } from "react"
import { Mic, Square, Download, Play, Pause, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "@/hooks/use-toast"

interface AudioRecording {
  id: string
  blob: Blob
  url: string
  duration: number
  timestamp: Date
}

export default function AudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [recordings, setRecordings] = useState<AudioRecording[]>([])
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
      }
      // Revoke all object URLs
      recordings.forEach((recording) => {
        URL.revokeObjectURL(recording.url)
      })
      // Pause and clean up all audio elements
      audioElementsRef.current.forEach((audio) => {
        audio.pause()
        audio.src = ""
      })
      audioElementsRef.current.clear()
    }
  }, [])

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        })
        const audioUrl = URL.createObjectURL(audioBlob)

        const newRecording: AudioRecording = {
          id: Date.now().toString(),
          blob: audioBlob,
          url: audioUrl,
          duration: recordingTime,
          timestamp: new Date(),
        }

        setRecordings((prev) => [newRecording, ...prev])
        setRecordingTime(0)

        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop())

        toast({
          title: "Recording Saved",
          description: "Your audio recording has been saved successfully",
        })
      }

      mediaRecorder.start()
      setIsRecording(true)
      setRecordingTime(0)

      // Start timer
      timerIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1)
      }, 1000)

      toast({
        title: "Recording Started",
        description: "Speak into your microphone",
      })
    } catch (error) {
      console.error("Error starting recording:", error)
      toast({
        title: "Recording Failed",
        description: "Could not access microphone. Please check permissions.",
        variant: "destructive",
      })
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)

      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
    }
  }

  const downloadRecording = (recording: AudioRecording) => {
    const link = document.createElement("a")
    link.href = recording.url
    link.download = `recording-${recording.id}.webm`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    toast({
      title: "Download Started",
      description: "Your recording is being downloaded",
    })
  }

  const deleteRecording = (id: string) => {
    const recording = recordings.find((r) => r.id === id)
    if (recording) {
      URL.revokeObjectURL(recording.url)
    }

    // Clean up audio element
    const audioElement = audioElementsRef.current.get(id)
    if (audioElement) {
      audioElement.pause()
      audioElement.src = ""
      audioElementsRef.current.delete(id)
    }

    setRecordings((prev) => prev.filter((r) => r.id !== id))
    if (playingId === id) {
      setPlayingId(null)
      setCurrentTime(0)
    }

    toast({
      title: "Recording Deleted",
      description: "Recording has been removed",
    })
  }

  const togglePlayPause = (recording: AudioRecording) => {
    let audioElement = audioElementsRef.current.get(recording.id)

    if (!audioElement) {
      audioElement = new Audio(recording.url)
      audioElementsRef.current.set(recording.id, audioElement)

      audioElement.addEventListener("timeupdate", () => {
        setCurrentTime(audioElement!.currentTime)
      })

      audioElement.addEventListener("ended", () => {
        setPlayingId(null)
        setCurrentTime(0)
      })
    }

    if (playingId === recording.id) {
      audioElement.pause()
      setPlayingId(null)
    } else {
      // Pause any other playing audio
      audioElementsRef.current.forEach((audio, id) => {
        if (id !== recording.id) {
          audio.pause()
        }
      })

      audioElement.play()
      setPlayingId(recording.id)
    }
  }

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const formatDate = (date: Date): string => {
    const now = new Date()
    const diffInMs = now.getTime() - date.getTime()
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60))

    if (diffInMinutes < 1) {
      return "Just now"
    } else if (diffInMinutes < 60) {
      return `${diffInMinutes} minute${diffInMinutes > 1 ? "s" : ""} ago`
    } else if (diffInMinutes < 1440) {
      const hours = Math.floor(diffInMinutes / 60)
      return `${hours} hour${hours > 1 ? "s" : ""} ago`
    } else {
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    }
  }

  return (
    <div className="flex-1 bg-white dark:bg-[#1E1E1E] flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-[#D7E0E9] dark:border-gray-700 px-6 py-4">
        <h1 className="text-2xl font-semibold text-[#384049] dark:text-[#F1F3F4] mb-1">
          Audio Recorder
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Record audio and save it for later
        </p>
      </div>

      {/* Recording Controls */}
      <div className="px-6 py-8 border-b border-[#D7E0E9] dark:border-gray-700">
        <div className="max-w-md mx-auto">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-900 rounded-2xl p-8 shadow-sm">
            {/* Recording Time Display */}
            <div className="text-center mb-6">
              <div className="text-5xl font-bold text-[#384049] dark:text-[#F1F3F4] font-mono">
                {formatTime(recordingTime)}
              </div>
              {isRecording && (
                <div className="mt-3 flex items-center justify-center gap-2 text-red-600 dark:text-red-400">
                  <div className="w-2 h-2 bg-red-600 dark:bg-red-400 rounded-full animate-pulse" />
                  <span className="text-sm font-medium">Recording...</span>
                </div>
              )}
            </div>

            {/* Recording Button */}
            <div className="flex justify-center">
              {!isRecording ? (
                <Button
                  onClick={startRecording}
                  size="lg"
                  className="h-20 w-20 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg transition-all hover:scale-105"
                >
                  <Mic size={32} />
                </Button>
              ) : (
                <Button
                  onClick={stopRecording}
                  size="lg"
                  className="h-20 w-20 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-lg transition-all hover:scale-105"
                >
                  <Square size={32} />
                </Button>
              )}
            </div>

            <div className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
              {!isRecording
                ? "Click the microphone to start recording"
                : "Click the square to stop recording"}
            </div>
          </div>
        </div>
      </div>

      {/* Recordings List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-lg font-semibold text-[#384049] dark:text-[#F1F3F4] mb-4">
            Your Recordings ({recordings.length})
          </h2>

          {recordings.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <Mic className="text-gray-400" size={28} />
              </div>
              <p className="text-gray-500 dark:text-gray-400">
                No recordings yet
              </p>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
                Start recording to see your audio files here
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {recordings.map((recording) => (
                <div
                  key={recording.id}
                  className="bg-white dark:bg-[#2A2A2A] border border-[#D7E0E9] dark:border-gray-700 rounded-lg p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center gap-4">
                    {/* Play/Pause Button */}
                    <button
                      onClick={() => togglePlayPause(recording)}
                      className="flex-shrink-0 w-12 h-12 rounded-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center transition-colors"
                    >
                      {playingId === recording.id ? (
                        <Pause size={20} />
                      ) : (
                        <Play size={20} className="ml-0.5" />
                      )}
                    </button>

                    {/* Recording Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4]">
                          Recording
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {formatTime(recording.duration)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {formatDate(recording.timestamp)}
                      </div>

                      {/* Progress Bar */}
                      {playingId === recording.id && (
                        <div className="mt-2">
                          <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 transition-all duration-100"
                              style={{
                                width: `${(currentTime / recording.duration) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => downloadRecording(recording)}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-600 dark:text-gray-400 transition-colors"
                        title="Download"
                      >
                        <Download size={18} />
                      </button>
                      <button
                        onClick={() => deleteRecording(recording.id)}
                        className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-red-600 dark:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
