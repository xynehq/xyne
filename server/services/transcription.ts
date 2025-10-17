import type { AutomaticSpeechRecognitionPipeline } from "@xenova/transformers"
import { pipeline } from "@xenova/transformers"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "transcription",
})

interface TranscriptSegment {
  speaker: string
  speakerIdentity: string
  text: string
  timestamp: Date
  confidence?: number
}

interface TranscriptionSession {
  callId: string
  transcriber: AutomaticSpeechRecognitionPipeline | null
  segments: TranscriptSegment[]
  audioBuffers: Map<string, Float32Array[]> // Store audio buffers per participant
  isActive: boolean
}

/**
 * Transcription service that receives audio from clients via WebSocket
 */
class TranscriptionService {
  private sessions: Map<string, TranscriptionSession> = new Map()
  private transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null =
    null

  constructor() {
    Logger.info("Transcription service initialized")
  }

  /**
   * Initialize Whisper model (lazy loaded)
   */
  private async getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
    if (!this.transcriberPromise) {
      Logger.info("Loading Whisper model...")
      this.transcriberPromise = pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-small", // Multilingual model that supports Hindi + Hinglish
        {
          quantized: true,
        },
      )
    }
    return this.transcriberPromise
  }

  /**
   * Start a transcription session for a call
   */
  async startTranscription(callId: string): Promise<void> {
    if (this.sessions.has(callId)) {
      Logger.warn(`Transcription already active for call ${callId}`)
      return
    }

    const session: TranscriptionSession = {
      callId,
      transcriber: null,
      segments: [],
      audioBuffers: new Map(),
      isActive: true,
    }

    this.sessions.set(callId, session)
    Logger.info(`Transcription started for call ${callId}`)
  }

  /**
   * Add audio chunk from a participant
   */
  async addAudioChunk(
    callId: string,
    participantId: string,
    participantName: string,
    audioData: Float32Array,
  ): Promise<void> {
    const session = this.sessions.get(callId)
    if (!session || !session.isActive) {
      return
    }

    // Initialize buffer for participant if needed
    if (!session.audioBuffers.has(participantId)) {
      session.audioBuffers.set(participantId, [])
    }

    const buffers = session.audioBuffers.get(participantId)!
    buffers.push(audioData)

    // Process when we have 5 seconds of audio
    const totalSamples = buffers.reduce((sum, buf) => sum + buf.length, 0)
    const sampleRate = 16000 // Whisper uses 16kHz
    const secondsOfAudio = totalSamples / sampleRate

    if (secondsOfAudio >= 5) {
      await this.transcribeAudioBuffer(session, participantId, participantName)
    }
  }

  /**
   * Transcribe accumulated audio buffer for a participant
   */
  private async transcribeAudioBuffer(
    session: TranscriptionSession,
    participantId: string,
    participantName: string,
  ): Promise<void> {
    const buffers = session.audioBuffers.get(participantId)
    if (!buffers || buffers.length === 0) return

    try {
      // Concatenate audio buffers
      const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0)
      const concatenated = new Float32Array(totalLength)
      let offset = 0
      for (const buf of buffers) {
        concatenated.set(buf, offset)
        offset += buf.length
      }

      // Clear buffers
      session.audioBuffers.set(participantId, [])

      // Get transcriber
      if (!session.transcriber) {
        session.transcriber = await this.getTranscriber()
      }

      // Transcribe with multilingual support
      // Note: whisper-small is multilingual by default and will auto-detect Hindi/English/Hinglish
      const result = await session.transcriber(concatenated, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      })

      // Handle result
      const text =
        (Array.isArray(result) ? result[0]?.text : result.text)?.trim() || ""

      if (text && text.length > 0) {
        const segment: TranscriptSegment = {
          speaker: participantName,
          speakerIdentity: participantId,
          text,
          timestamp: new Date(),
        }

        session.segments.push(segment)
        Logger.info(`[${participantName}]: ${text}`)
      }
    } catch (error) {
      Logger.error(
        error,
        `Error transcribing audio for participant ${participantId}`,
      )
    }
  }

  /**
   * Stop transcription and return the full transcript
   */
  async stopTranscription(callId: string): Promise<TranscriptSegment[]> {
    const session = this.sessions.get(callId)

    if (!session) {
      return []
    }

    try {
      session.isActive = false

      // Process any remaining audio
      for (const [participantId, buffers] of session.audioBuffers.entries()) {
        if (buffers.length > 0) {
          const lastSegment = session.segments.find(
            (s) => s.speakerIdentity === participantId,
          )
          const participantName = lastSegment?.speaker || participantId
          await this.transcribeAudioBuffer(
            session,
            participantId,
            participantName,
          )
        }
      }

      const segments = session.segments
      this.sessions.delete(callId)

      Logger.info(
        `Transcription stopped for call ${callId} - ${segments.length} segments`,
      )

      return segments
    } catch (error) {
      Logger.error(error, `Error stopping transcription for call ${callId}`)
      this.sessions.delete(callId)
      return session.segments || []
    }
  }

  /**
   * Get current transcript for an active call
   */
  getCurrentTranscript(callId: string): TranscriptSegment[] {
    const session = this.sessions.get(callId)
    return session?.segments || []
  }

  /**
   * Check if transcription is active for a call
   */
  isTranscribing(callId: string): boolean {
    return this.sessions.has(callId)
  }
}

// Export singleton instance
export const transcriptionService = new TranscriptionService()

export type { TranscriptSegment, TranscriptionSession }
