import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { spawn } from "child_process"
import { promises as fs } from "fs"
import * as path from "path"
import type PgBoss from "pg-boss"
import config from "@/config"
import {
  refineTranscript,
  mergeConsecutiveSegments,
  type TranscriptResult,
} from "@/services/transcriptRefinement"

const Logger = getLogger(Subsystem.Queue).child({ module: "asrProcessor" })

// Paths
const ASR_SD_DIR = path.join(process.cwd(), "asr-sd")
const PYTHON_EXECUTABLE = process.env.PYTHON_PATH || "python3"

// Helper to format timestamp as HH:MM:SS.mmm
function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  const secsStr = secs.toFixed(3).padStart(6, "0") // e.g. "01.234"
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${secsStr}`
}

export enum ASRJobType {
  Transcribe = "transcribe",
}

export interface TranscribeJobData {
  type: ASRJobType.Transcribe
  jobId: string
  audioUrl: string
  audioPath: string
  outputPath: string
  whisperModel?: string
  language?: string
  numSpeakers?: number
  minSpeakers?: number
  maxSpeakers?: number
  multilingual?: boolean
  refineWithLLM?: boolean
  hfToken?: string
  outputFormat?: string
}

export type ASRJobData = TranscribeJobData

// Helper function to run Python script
async function runPythonScript(
  scriptName: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ASR_SD_DIR, scriptName)
    const pythonProcess = spawn(PYTHON_EXECUTABLE, [scriptPath, ...args])

    let stdout = ""
    let stderr = ""

    pythonProcess.stdout.on("data", (data) => {
      const output = data.toString()
      stdout += output
      Logger.info({ output }, "Python stdout")
    })

    pythonProcess.stderr.on("data", (data) => {
      const output = data.toString()
      stderr += output
      Logger.warn({ output }, "Python stderr")
    })

    pythonProcess.on("close", (code, signal) => {
      const exitCode = code ?? -1 // if null (killed by signal), treat as failure
      Logger.info({ exitCode, signal }, "Python process exited")
      resolve({
        stdout,
        stderr,
        exitCode,
      })
    })

    pythonProcess.on("error", (error) => {
      Logger.error({ error }, "Failed to start Python process")
      reject(error)
    })
  })
}

// Helper function to download file from URL
async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`)
  }
  const buffer = await response.arrayBuffer()
  await fs.writeFile(outputPath, Buffer.from(buffer))
}

// Helper function to convert audio to optimal format for Whisper/Pyannote
// Target: mono, 16 kHz, 16-bit PCM .wav
async function convertAudioToOptimalFormat(
  inputPath: string,
  outputPath: string
): Promise<void> {
  Logger.info(
    { inputPath, outputPath },
    "Converting audio to optimal format (mono, 16kHz, 16-bit PCM WAV)",
  )

  const ffmpegArgs = [
    "-i",
    inputPath, // Input file
    "-ac",
    "1", // Convert to mono (1 audio channel)
    "-ar",
    "16000", // Sample rate: 16 kHz
    "-sample_fmt",
    "s16", // 16-bit PCM
    "-acodec",
    "pcm_s16le", // PCM 16-bit little-endian codec
    "-y", // Overwrite output file if exists
    outputPath,
  ]

  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs)

    let stderr = ""

    ffmpegProcess.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        Logger.info({ outputPath }, "Audio conversion completed successfully")
        resolve()
      } else {
        Logger.error({ exitCode: code, stderr }, "FFmpeg conversion failed")
        reject(new Error(`FFmpeg conversion failed with code ${code}: ${stderr}`))
      }
    })

    ffmpegProcess.on("error", (error) => {
      Logger.error({ error }, "Failed to start FFmpeg process")
      reject(new Error(`Failed to start FFmpeg: ${error.message}`))
    })
  })
}

// Handle transcription jobs
async function handleTranscribeJob(
  boss: PgBoss, // currently unused, but kept for future extensions
  job: PgBoss.Job<TranscribeJobData>,
): Promise<void> {
  const data = job.data
  Logger.info({ jobId: data.jobId }, "Starting transcription job")

  try {
    // Download audio file
    Logger.info({ audioUrl: data.audioUrl, audioPath: data.audioPath }, "Downloading audio file")
    await downloadFile(data.audioUrl, data.audioPath)

    // Convert audio to optimal format (mono, 16kHz, 16-bit PCM WAV)
    const convertedAudioPath = data.audioPath.replace(/\.[^.]+$/, "_converted.wav")
    Logger.info({ convertedAudioPath }, "Using converted audio path")
    await convertAudioToOptimalFormat(data.audioPath, convertedAudioPath)

    // Build command arguments for simplified Python script (ASR + Diarization only)
    const args = [
      convertedAudioPath, // Use converted audio
      "--whisper-model",
      data.whisperModel || "turbo",
      "--output",
      data.outputPath + "_raw.json", // Output raw results
    ]

    if (data.language) args.push("--language", data.language)
    if (data.numSpeakers) args.push("--num-speakers", data.numSpeakers.toString())
    if (data.minSpeakers) args.push("--min-speakers", data.minSpeakers.toString())
    if (data.maxSpeakers) args.push("--max-speakers", data.maxSpeakers.toString())

    // Default: multilingual ON unless explicitly disabled (but in your pipeline: always true)
    const multilingual = data.multilingual !== false
    if (multilingual) {
      args.push("--multilingual")
    }

    // Use HF_TOKEN from environment or from job data
    const hfToken = process.env.HF_TOKEN || data.hfToken
    if (hfToken) {
      args.push("--hf-token", hfToken)
    }

    // Run simplified Python script (ASR + Diarization only)
    Logger.info({ args }, "Running whisper_diarization.py (ASR + Diarization)")
    const result = await runPythonScript("whisper_diarization.py", args)

    if (result.exitCode !== 0) {
      throw new Error(`Transcription failed (exit ${result.exitCode}): ${result.stderr}`)
    }

    Logger.info(
      { jobId: data.jobId, rawOutputPath: data.outputPath + "_raw.json" },
      "ASR + Diarization completed, starting TypeScript post-processing",
    )

    // Read the raw transcript JSON output from Python
    const rawJsonPath = data.outputPath + "_raw.json"
    const rawTranscriptData = await fs.readFile(rawJsonPath, "utf-8")
    const rawTranscript: TranscriptResult = JSON.parse(rawTranscriptData)

    // Decide whether to refine with LLM (default true if undefined)
    const shouldRefine = data.refineWithLLM !== false

    let finalTranscript: TranscriptResult = rawTranscript

    if (shouldRefine) {
      Logger.info({ jobId: data.jobId }, "Starting LLM refinement in TypeScript")

      // Check which LLM provider is configured
      const { defaultBestModel } = config

      if (!defaultBestModel) {
        Logger.warn(
          {
            jobId: data.jobId,
          },
          "No LLM provider configured for ASR refinement. Skipping refinement and using raw transcript.",
        )
      } else {
        try {
          // Run TypeScript refinement (works with any configured LLM provider)
          finalTranscript = await refineTranscript(rawTranscript, {
            maxTokens: 200000,
          })
          Logger.info({ jobId: data.jobId }, "LLM refinement completed successfully")
        } catch (error) {
          Logger.error(
            { error, jobId: data.jobId },
            "LLM refinement failed, falling back to raw transcript",
          )
          finalTranscript = rawTranscript
        }
      }
    } else {
      // Even without LLM refinement, merge consecutive segments deterministically
      Logger.info(
        { jobId: data.jobId },
        "LLM refinement disabled, merging consecutive segments without refinement",
      )
      finalTranscript = {
        ...rawTranscript,
        segments: mergeConsecutiveSegments(rawTranscript.segments),
      }
    }

    // Save final results in requested format(s)
    const outputFormat = data.outputFormat || "json"
    const suffix = shouldRefine ? "_refined" : "_merged"

    if (outputFormat === "json" || outputFormat === "all") {
      const jsonPath = data.outputPath + suffix + ".json"
      await fs.writeFile(jsonPath, JSON.stringify(finalTranscript, null, 2), "utf-8")
      Logger.info({ jobId: data.jobId, path: jsonPath }, "Saved JSON output")
    }

    if (outputFormat === "txt" || outputFormat === "all") {
      const txtPath = data.outputPath + suffix + ".txt"
      const txtContent = finalTranscript.segments
        .map((seg) => `[${seg.speaker || "UNKNOWN"}] ${seg.text.trim()}`)
        .join("\n")
      await fs.writeFile(txtPath, txtContent, "utf-8")
      Logger.info({ jobId: data.jobId, path: txtPath }, "Saved TXT output")
    }

    if (outputFormat === "srt" || outputFormat === "all") {
      const srtPath = data.outputPath + suffix + ".srt"
      const srtContent = finalTranscript.segments
        .map((seg, idx) => {
          const start = formatTimestamp(seg.start).replace(".", ",")
          const end = formatTimestamp(seg.end).replace(".", ",")
          const text = `[${seg.speaker || "UNKNOWN"}] ${seg.text.trim()}`
          return `${idx + 1}\n${start} --> ${end}\n${text}\n`
        })
        .join("\n")
      await fs.writeFile(srtPath, srtContent, "utf-8")
      Logger.info({ jobId: data.jobId, path: srtPath }, "Saved SRT output")
    }

    Logger.info({ jobId: data.jobId }, "Transcription pipeline completed successfully")
  } catch (error) {
    Logger.error({ error, jobId: data.jobId }, "Transcription job failed")
    throw error
  }
}

// Main job handler
export async function handleASRJob(
  boss: PgBoss,
  job: PgBoss.Job<ASRJobData>,
): Promise<void> {
  const data = job.data
  Logger.info({ jobId: data.jobId, type: data.type }, "Processing ASR job")

  try {
    switch (data.type) {
      case ASRJobType.Transcribe:
        await handleTranscribeJob(boss, job as PgBoss.Job<TranscribeJobData>)
        break
      default:
        Logger.error({ jobId: data.jobId, type: data.type }, "Unknown ASR job type")
        throw new Error(`Unknown ASR job type: ${data.type}`)
    }

    Logger.info({ jobId: data.jobId }, "ASR job completed")
  } catch (error) {
    Logger.error({ error, jobId: data.jobId }, "ASR job failed")
    throw error
  }
}
