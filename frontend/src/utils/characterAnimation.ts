/**
 * Character Animation Engine for streaming chat responses
 * Handles character-by-character rendering with configurable intervals and batch sizes
 */

export interface CharacterAnimationOptions {
  interval: number // milliseconds between character batches
  batchSize: number // number of characters to render per interval
  onUpdate: (displayText: string) => void
  onComplete?: () => void
}

export class CharacterQueue {
  private queue: string[] = []
  private displayed: string = ""
  private isAnimating: boolean = false
  private animationId: number | null = null
  private lastCharTime: number = 0
  private options: CharacterAnimationOptions

  constructor(options: CharacterAnimationOptions) {
    this.options = options
  }

  /*Add a new chunk of text to the animation queue*/
  addChunk(chunk: string): void {
    if (!chunk) return

    // Split chunk into individual characters and add to queue
    const characters = Array.from(chunk)
    this.queue.push(...characters)

    // Start animation if not already running
    if (!this.isAnimating) {
      this.startAnimation()
    }
  }

  /* Start the character-by-character animation*/
  private startAnimation(): void {
    if (this.isAnimating) return

    this.isAnimating = true
    this.lastCharTime = performance.now()
    this.animate()
  }

  /*Animation loop using requestAnimationFrame for smooth performance*/
  private animate = (): void => {
    if (!this.isAnimating) return

    const now = performance.now()
    const elapsed = now - this.lastCharTime

    // Check if enough time has passed for the next batch of characters
    if (elapsed >= this.options.interval && this.queue.length > 0) {
      // Process a batch of characters based on batchSize
      const charsToProcess = Math.min(this.options.batchSize, this.queue.length)
      let batchText = ""

      for (let i = 0; i < charsToProcess; i++) {
        const nextChar = this.queue.shift()
        if (nextChar !== undefined) {
          batchText += nextChar
        }
      }

      if (batchText) {
        this.displayed += batchText
        this.lastCharTime = now

        // Notify about the update
        this.options.onUpdate(this.displayed)
      }
    }

    // Continue animation if there are more characters
    if (this.queue.length > 0) {
      this.animationId = requestAnimationFrame(this.animate)
    } else {
      this.stopAnimation()
    }
  }

  /*Stop the animation*/
  stopAnimation(): void {
    this.isAnimating = false
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }

    // If there are still queued characters, display them all immediately
    if (this.queue.length > 0) {
      this.displayed += this.queue.join("")
      this.queue = []
      this.options.onUpdate(this.displayed)
    }

    this.options.onComplete?.()
  }

  /*Get the current displayed text*/
  getDisplayed(): string {
    return this.displayed
  }

  /*Check if animation is currently running*/
  isRunning(): boolean {
    return this.isAnimating
  }

  /* Reset the queue and displayed text*/
  reset(): void {
    this.stopAnimation()
    this.queue = []
    this.displayed = ""
  }

  /**
   * Set the entire text immediately (for completed streams)
   */
  setImmediate(text: string): void {
    this.reset()
    this.displayed = text
    this.options.onUpdate(this.displayed)
  }
}

export class CharacterAnimationManager {
  private queues: Map<string, CharacterQueue> = new Map()
  private updateCallbacks: Map<string, (text: string) => void> = new Map()

  getQueue(
    key: string,
    onUpdate: (text: string) => void,
    onComplete?: () => void,
    options?: Partial<
      Pick<CharacterAnimationOptions, "interval" | "batchSize">
    >,
  ): CharacterQueue {
    if (!this.queues.has(key)) {
      const queue = new CharacterQueue({
        interval: options?.interval ?? 1, // 2ms for 1 character per 2ms as requested
        batchSize: options?.batchSize ?? 3, // 1 character per interval by default
        onUpdate,
        onComplete,
      })
      this.queues.set(key, queue)
      this.updateCallbacks.set(key, onUpdate)
    }
    return this.queues.get(key)!
  }
  addToQueue(key: string, chunk: string): void {
    const queue = this.queues.get(key)
    if (queue) {
      queue.addChunk(chunk)
    }
  }
  stopQueue(key: string): void {
    const queue = this.queues.get(key)
    if (queue) {
      queue.stopAnimation()
    }
  }
  stopAll(): void {
    this.queues.forEach((queue) => queue.stopAnimation())
  }
  cleanupQueue(key: string): void {
    const queue = this.queues.get(key)
    if (queue) {
      queue.stopAnimation()
      this.queues.delete(key)
      this.updateCallbacks.delete(key)
    }
  }
  /* Clean up all queues*/
  cleanup(): void {
    this.queues.forEach((queue) => queue.stopAnimation())
    this.queues.clear()
    this.updateCallbacks.clear()
  }

  /* Set text immediately for a completed stream*/
  setImmediate(key: string, text: string): void {
    const queue = this.queues.get(key)
    if (queue) {
      queue.setImmediate(text)
    }
  }

  /* Get current displayed text for a queue*/
  getDisplayed(key: string): string {
    const queue = this.queues.get(key)
    return queue ? queue.getDisplayed() : ""
  }

  /*Check if any animations are running*/
  hasActiveAnimations(): boolean {
    return Array.from(this.queues.values()).some((queue) => queue.isRunning())
  }

  /* Wait for all animations to complete
   * Returns a Promise that resolves when all character animations are finished*/
  waitForAllAnimationsComplete(): Promise<void> {
    return new Promise((resolve) => {
      // If no animations are running, resolve immediately
      if (!this.hasActiveAnimations()) {
        resolve()
        return
      }

      // Check every 10ms if all animations are complete
      const checkInterval = setInterval(() => {
        if (!this.hasActiveAnimations()) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 10)
    })
  }
}
