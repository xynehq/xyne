interface SpanAttributes {
  [key: string]: string | number | boolean | null
}

export interface SpanEvent {
  name: string
  timestamp: number
  attributes?: SpanAttributes
}

export interface Tracer {
  startSpan(name: string, options?: { parentSpan?: Span }): Span
  setAttribute(
    span: Span,
    key: string,
    value: string | number | boolean | null,
  ): void
  addEvent(span: Span, name: string, attributes?: SpanAttributes): void
  endSpan(span: Span): void
  serializeToJson(): string
}

// Span interface remains for type compatibility
export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number | null
  endTime: number | null
  duration: number | null
  attributes: SpanAttributes
  events: SpanEvent[]
  setAttribute(key: string, value: string | number | boolean | null): Span
  addEvent(name: string, attributes?: SpanAttributes): Span
  startSpan(name: string): Span
  end(): Span
}

// Span implementation as a class
class SpanImpl implements Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number | null
  endTime: number | null
  duration: number | null
  attributes: SpanAttributes
  events: SpanEvent[]
  private tracer: Tracer

  constructor(
    tracer: Tracer,
    traceId: string,
    spanId: string,
    name: string,
    parentSpanId?: string,
  ) {
    this.tracer = tracer
    this.traceId = traceId
    this.spanId = spanId
    this.parentSpanId = parentSpanId
    this.name = name
    this.startTime = Date.now()
    this.endTime = null
    this.duration = null
    this.attributes = {}
    this.events = []
  }

  setAttribute(key: string, value: string | number | boolean | null): Span {
    this.tracer.setAttribute(this, key, value)
    return this
  }

  addEvent(name: string, attributes?: SpanAttributes): Span {
    this.tracer.addEvent(this, name, attributes)
    return this
  }

  startSpan(name: string): Span {
    return this.tracer.startSpan(name, { parentSpan: this })
  }

  end(): Span {
    this.tracer.endSpan(this)
    return this
  }
}

export class CustomTracer implements Tracer {
  private spans: Span[] = []
  private traceId: string
  private langfuseTrace: any = null
  private traceName: string

  constructor(name: string) {
    this.traceId = `${name}-${Math.random().toString(16).substring(2, 18)}`
    this.traceName = name

    // Initialize LangFuse trace if available
    try {
      const { getLangfuseInstance } = require("./ai/langfuse")
      const langfuse = getLangfuseInstance()
      if (langfuse) {
        this.langfuseTrace = langfuse.trace({
          name: name,
          id: this.traceId,
          metadata: {
            source: "custom-tracer",
            timestamp: new Date().toISOString(),
          },
        })
      }
    } catch (error) {
      // LangFuse not available, continue without it
    }
  }

  startSpan(name: string, options: { parentSpan?: Span } = {}): Span {
    const spanId = `${name}-${Math.random().toString(16).substring(2, 10)}`
    const span = new SpanImpl(
      this,
      this.traceId,
      spanId,
      name,
      options.parentSpan?.spanId,
    )
    this.spans.push(span)
    return span
  }

  setAttribute(
    span: Span,
    key: string,
    value: string | number | boolean | null,
  ): void {
    span.attributes[key] = value
  }

  addEvent(span: Span, name: string, attributes?: SpanAttributes): void {
    span.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    })
  }

  endSpan(span: Span): void {
    span.endTime = Date.now()
    span.duration = span.endTime - (span.startTime || 0)

    // Send to LangFuse if available
    if (this.langfuseTrace) {
      try {
        this.langfuseTrace.span({
          name: span.name,
          id: span.spanId,
          input: span.attributes,
          output: span.attributes,
          metadata: {
            events: span.events,
            duration: span.duration,
          },
          startTime: span.startTime ? new Date(span.startTime) : undefined,
          endTime: span.endTime ? new Date(span.endTime) : undefined,
        })

        // Auto-flush if this is the root span (no parent)
        if (!span.parentSpanId) {
          const { getLangfuseInstance } = require("./ai/langfuse")
          const langfuse = getLangfuseInstance()
          if (langfuse) {
            langfuse.flushAsync().catch(() => {
              // Ignore flush errors
            })
          }
        }
      } catch (error) {
        // Ignore LangFuse errors to not break the application
      }
    }
  }

  serializeToJson(): string {
    const traceJson = {
      traceId: this.traceId,
      spans: this.spans.map((span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId || null,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration,
        attributes: span.attributes,
        events: span.events,
      })),
    }
    return JSON.stringify(traceJson)
  }
}

export function getTracer(name: string): Tracer {
  return new CustomTracer(name)
}
