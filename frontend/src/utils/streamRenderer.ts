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

  /** Add a new chunk of text to the animation queue */
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
    let accumulatedElapsed = now - this.lastCharTime

    // Process multiple batches if enough time has accumulated
    // Add safe cap to prevent pathological backlogs
    const maxLoops = 100
    let loopCount = 0

    // Aggregate all characters processed during this animation frame
    let aggregatedText = ""
    let hasProcessedChars = false

    while (
      accumulatedElapsed >= this.options.interval &&
      this.queue.length > 0 &&
      loopCount < maxLoops
    ) {
      // Process a batch of characters based on batchSize
      const charsToProcess = Math.min(this.options.batchSize, this.queue.length)
      // let batchText = ""

      // for (let i = 0; i < charsToProcess; i++) {
      //   const nextChar = this.queue.shift()
      //   if (nextChar !== undefined) {
      //     batchText += nextChar
      //   }
      // }
      const batchText = this.queue.splice(0, charsToProcess).join("")

      if (batchText) {
        aggregatedText += batchText
        hasProcessedChars = true
      }

      // Decrement accumulated elapsed time by the interval
      accumulatedElapsed -= this.options.interval
      loopCount++
    }

    // Update displayed text once with all aggregated characters and call onUpdate once
    if (hasProcessedChars) {
      this.displayed += aggregatedText
      this.options.onUpdate(this.displayed)
    }

    // Update lastCharTime to maintain timing accuracy
    // If we have remaining accumulated time, subtract it from now
    // Otherwise, if we've drained all accumulated time, set to now
    this.lastCharTime = accumulatedElapsed > 0 ? now - accumulatedElapsed : now

    // Continue animation if there are more characters
    if (this.queue.length > 0) {
      this.animationId = requestAnimationFrame(this.animate)
    } else {
      this.stopAnimation()
    }
  }

  /*Stop the animation*/
  stopAnimation(flush: boolean = true): void {
    this.isAnimating = false
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }

    if (flush) {
      // If there are still queued characters, display them all immediately
      if (this.queue.length > 0) {
        this.displayed += this.queue.join("")
        this.queue = []
        this.options.onUpdate(this.displayed)
      }

      this.options.onComplete?.()
    }
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
    this.stopAnimation(false)
    this.queue = []
    this.displayed = ""
    this.options.onUpdate(this.displayed)
  }

  /**
   * Set the entire text immediately (for completed streams)
   */
  setImmediate(text: string): void {
    // Detect if there was work in flight before clearing
    const hadWorkInFlight = this.queue.length > 0 || this.isAnimating

    // Stop animation without flushing queue and clear all state
    this.stopAnimation(false)
    this.queue = []
    this.displayed = text
    this.options.onUpdate(this.displayed)

    // If there was work in flight, signal completion to resolve any pending waits
    if (hadWorkInFlight) {
      this.options.onComplete?.()
    }
  }

  /**
   * Update the callback functions with fresh closures from React re-renders
   */
  updateCallbacks(
    onUpdate: (displayText: string) => void,
    onComplete?: () => void,
  ): void {
    this.options.onUpdate = onUpdate
    this.options.onComplete = onComplete
  }
}

export class CharacterAnimationManager {
  private queues: Map<string, CharacterQueue> = new Map()
  private updateCallbacks: Map<string, (text: string) => void> = new Map()
  private pendingCompletionResolvers: Array<() => void> = []

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
        interval: options?.interval ?? 6, // 6ms
        batchSize: options?.batchSize ?? 1, // 1 character
        onUpdate,
        onComplete: () => {
          // Call the original onComplete callback
          onComplete?.()
          // Check if all animations are complete and resolve any pending promises
          this.checkAndResolveCompletionPromises()
        },
      })
      this.queues.set(key, queue)
      this.updateCallbacks.set(key, onUpdate)
    } else {
      // Update existing queue's callbacks with fresh closures from React re-render
      const queue = this.queues.get(key)!
      queue.updateCallbacks(onUpdate, () => {
        // Call the original onComplete callback
        onComplete?.()
        // Check if all animations are complete and resolve any pending promises
        this.checkAndResolveCompletionPromises()
      })
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
      // Check if all animations are now complete
      this.checkAndResolveCompletionPromises()
    }
  }
  stopAll(): void {
    this.queues.forEach((queue) => queue.stopAnimation())
    // After stopping all, resolve any pending completion promises
    this.resolveAllCompletionPromises()
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
    // Resolve any pending completion promises since we're cleaning up
    this.resolveAllCompletionPromises()
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

  /**
   * Check if all animations are complete and resolve pending promises
   * This is called whenever a queue completes its animation
   */
  private checkAndResolveCompletionPromises(): void {
    if (
      !this.hasActiveAnimations() &&
      this.pendingCompletionResolvers.length > 0
    ) {
      this.resolveAllCompletionPromises()
    }
  }

  /**
   * Resolve all pending completion promises
   */
  private resolveAllCompletionPromises(): void {
    const resolvers = [...this.pendingCompletionResolvers]
    this.pendingCompletionResolvers = []
    resolvers.forEach((resolve) => resolve())
  }

  /**
   * Wait for all animations to complete (Event-driven approach)
   * Returns a Promise that resolves when all character animations are finished
   * This improved version uses event-driven completion detection instead of polling
   */
  waitForAllAnimationsComplete(): Promise<void> {
    return new Promise((resolve) => {
      // Push the resolver first to avoid race condition
      this.pendingCompletionResolvers.push(resolve)

      // Then immediately re-check if animations are actually running
      // If not, remove the resolver and call it synchronously
      if (!this.hasActiveAnimations()) {
        // Remove the resolver we just added
        const index = this.pendingCompletionResolvers.indexOf(resolve)
        if (index > -1) {
          this.pendingCompletionResolvers.splice(index, 1)
        }
        // Resolve immediately
        resolve()
      }
    })
  }
}
