import { z } from "zod"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { promises as fs } from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import { boss, ASRQueue } from "@/queue"
import type { TranscribeJobData } from "@/queue/asrProcessor"
import { ASRJobType } from "@/queue/asrProcessor"
import config from "@/config"

const Logger = getLogger(Subsystem.Api).child({ module: "asr" })

// Paths
const ASR_SD_DIR = path.join(process.cwd(), "asr-sd")

// Schemas
export const transcribeAudioSchema = z.object({
  audioUrl: z.string({ message: "Invalid audio URL" }).url(),
  whisperModel: z
    .enum(["tiny", "base", "small", "medium", "large", "large-v2", "large-v3", "turbo"])
    .default("turbo")
    .optional(),
  language: z.string().optional(),
  numSpeakers: z.number().int().positive().optional(),
  minSpeakers: z.number().int().positive().optional(),
  maxSpeakers: z.number().int().positive().optional(),
  multilingual: z.boolean().default(true).optional(),
  refineWithLLM: z.boolean().default(true).optional(),
  outputFormat: z.enum(["txt", "json", "srt", "all"]).default("json").optional(),
})

export const getJobStatusSchema = z.object({
  jobId: z.string({ message: "Invalid job ID" }).uuid(),
})

// API: Transcribe audio with speaker diarization (enqueues job)
export const TranscribeAudioApi = async (c: Context) => {
  try {
    const body = c.req.valid("json" as never) as z.infer<typeof transcribeAudioSchema>
    const {
      audioUrl,
      whisperModel = "turbo",
      language,
      numSpeakers,
      minSpeakers,
      maxSpeakers,
      outputFormat = "json",
    } = body

    // We always run multilingual + LLM refinement in this pipeline.
    const multilingual = true
    const refineWithLLM = true

    // Basic sanity check for speaker bounds
    if (minSpeakers !== undefined && maxSpeakers !== undefined && minSpeakers > maxSpeakers) {
      throw new HTTPException(400, {
        message: "minSpeakers cannot be greater than maxSpeakers.",
      })
    }

    // Restrict audio URL to http/https to avoid weird protocols (file://, ftp, etc.)
    let parsedUrl: URL
    try {
      parsedUrl = new URL(audioUrl)
    } catch {
      throw new HTTPException(400, { message: "Invalid audio URL" })
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new HTTPException(400, {
        message: "audioUrl must use http or https scheme",
      })
    }

    // Check which LLM provider is configured (following same logic as config.ts)
    const { defaultBestModel } = config
    if (!defaultBestModel) {
      throw new HTTPException(400, {
        message:
          "No LLM provider configured for ASR refinement. " +
          "Please configure an AI provider (Vertex AI, OpenAI, AWS Bedrock, etc.) in your environment.",
      })
    }

    // Use HF_TOKEN from environment (required for diarization)
    const hfToken = process.env.HF_TOKEN
    if (!hfToken) {
      throw new HTTPException(400, {
        message: "HF_TOKEN not configured. Required for speaker diarization.",
      })
    }

    const jobId = randomUUID()
    const tempDir = path.join(ASR_SD_DIR, "temp", jobId)

    // Create temp directory
    await fs.mkdir(tempDir, { recursive: true })

    const audioExt = path.extname(parsedUrl.pathname) || ".mp3"
    const audioPath = path.join(tempDir, `audio${audioExt}`)
    const outputBase = path.join(tempDir, "transcription")

    // Create job data for unified automated pipeline
    const jobData: TranscribeJobData = {
      type: ASRJobType.Transcribe,
      jobId,
      audioUrl,
      audioPath,
      outputPath: outputBase,
      whisperModel,
      language,
      numSpeakers,
      minSpeakers,
      maxSpeakers,
      multilingual,      // always true in this pipeline
      refineWithLLM,     // always true in this pipeline
      hfToken,
      outputFormat,
    }

    // Enqueue job
    Logger.info({ jobId, audioUrl }, "Enqueuing transcription job")
    const queueJobId = await boss.send(ASRQueue, jobData, {
      expireInHours: 24,
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
    })

    Logger.info({ jobId, queueJobId }, "Transcription job enqueued")

    return c.json({
      success: true,
      jobId,
      queueJobId,
      status: "queued",
      message: "Transcription job has been queued for processing",
    })
  } catch (error) {
    Logger.error({ error }, "Error in TranscribeAudioApi")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: error instanceof Error ? error.message : "Unknown error occurred",
    })
  }
}

// API: Get job status and results
export const GetJobStatusApi = async (c: Context) => {
  try {
    const { jobId } = c.req.valid("query" as never) as z.infer<typeof getJobStatusSchema>

    Logger.info({ jobId }, "Getting job status")

    // Get job status from PgBoss
    const job = await boss.getJobById(ASRQueue, jobId)

    if (!job) {
      throw new HTTPException(404, {
        message: "Job not found",
      })
    }

    const tempDir = path.join(ASR_SD_DIR, "temp", jobId)
    let outputs: Record<string, any> = {}

    // If job is completed, read output files
    if (job.state === "completed") {
      try {
        const jobData = job.data as TranscribeJobData
        const suffix = jobData.refineWithLLM ? "_refined" : "_raw"
        const format = jobData.outputFormat || "json"

        if (format === "json" || format === "all") {
          const jsonPath = path.join(tempDir, `transcription${suffix}.json`)
          try {
            const jsonContent = await fs.readFile(jsonPath, "utf-8")
            outputs.json = JSON.parse(jsonContent)
          } catch (error) {
            Logger.warn({ error, jsonPath }, "Failed to read JSON output")
          }
        }

        if (format === "txt" || format === "all") {
          const txtPath = path.join(tempDir, `transcription${suffix}.txt`)
          try {
            outputs.txt = await fs.readFile(txtPath, "utf-8")
          } catch (error) {
            Logger.warn({ error, txtPath }, "Failed to read TXT output")
          }
        }

        if (format === "srt" || format === "all") {
          const srtPath = path.join(tempDir, `transcription${suffix}.srt`)
          try {
            outputs.srt = await fs.readFile(srtPath, "utf-8")
          } catch (error) {
            Logger.warn({ error, srtPath }, "Failed to read SRT output")
          }
        }
      } catch (error) {
        Logger.warn({ error }, "Error reading output files")
      }
    }

    return c.json({
      success: true,
      jobId,
      status: job.state,
      createdOn: job.createdOn,
      startedOn: job.startedOn,
      completedOn: job.completedOn,
      outputs: Object.keys(outputs).length > 0 ? outputs : undefined,
      error: (job as any).output?.error,
    })
  } catch (error) {
    Logger.error({ error }, "Error in GetJobStatusApi")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: error instanceof Error ? error.message : "Unknown error occurred",
    })
  }
}
