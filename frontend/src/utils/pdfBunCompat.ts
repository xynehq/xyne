import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api"

/**
 * Bun-optimized PDF.js configuration
 * 
 * This module provides Bun-specific configurations for PDF.js
 * since we're targeting Bun as our runtime environment.
 */

// We're using Bun, so always use Bun-optimized settings
export const isBun = true

/**
 * Get Bun-optimized PDF.js worker source
 */
export function getPdfWorkerSrc(): string {
  // Always use legacy worker for Bun compatibility
  return "/pdfjs/pdf.worker.min.mjs"
}

// Create a stable default options object
const DEFAULT_PDF_OPTIONS = Object.freeze({
  // Character maps for international text support
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,

  // Standard fonts for consistent text rendering
  standardFontDataUrl: "/pdfjs/standard_fonts/",

  // ICC color profiles for accurate color rendering
  iccUrl: "/pdfjs/iccs/",

  // WASM files for advanced image processing
  wasmUrl: "/pdfjs/wasm/",

  // System fonts fallback
  useSystemFonts: true,

  // Worker and performance settings
  useWorkerFetch: true,
  useWasm: true,

  // Security and evaluation
  isEvalSupported: false,

  // Logging
  verbosity: 0,

  // XFA forms support
  enableXfa: true,

  // Font handling
  disableFontFace: false,
  fontExtraProperties: false,

  // Canvas and rendering
  isOffscreenCanvasSupported: true,
  isImageDecoderSupported: true,
  canvasMaxAreaInBytes: 1024 * 1024 * 20, // 20MB limit for Bun

  // Error handling
  stopAtErrors: false,

  // Hardware acceleration
  enableHWA: false,
})

/**
 * Get Bun-optimized PDF.js document options
 */
export function getPdfDocumentOptions(baseOptions: Partial<DocumentInitParameters> = {}) {
  const defaultOptions = {
    ...DEFAULT_PDF_OPTIONS,
    ...baseOptions,
  }

  // Bun-specific optimizations
  return {
    ...defaultOptions,
    // Enable range requests for better Bun compatibility
    disableRange: false,
    // Enable streaming for better performance
    disableStream: false,
    // Disable auto-fetch to prevent memory issues in Bun
    disableAutoFetch: false,
    // Reduce memory usage for Bun
    maxImageSize: 1024 * 1024 * 20, // 20MB limit
  }
}

/**
 * Get Bun-optimized PDFPageView options
 */
export function getPdfPageViewOptions(baseOptions: any = {}) {
  const defaultOptions = {
    textLayerMode: 1, // Enable text layer
    annotationMode: 2, // Enable annotations
    imageResourcesPath: "/pdfjs/images/", // Path for annotation icons
    ...baseOptions,
  }

  // Bun-optimized settings
  return {
    ...defaultOptions,
    maxCanvasPixels: 1024 * 1024 * 20, // 20MB limit for Bun
  }
}

/**
 * Handle PDF loading errors with Bun-specific error messages
 */
export function handlePdfError(error: Error): string {
  // Provide Bun-specific error context
  if (error.message.includes("worker")) {
    return `PDF worker error in Bun: ${error.message}. Try refreshing the page.`
  }
  if (error.message.includes("font") || error.message.includes("text")) {
    return `PDF text rendering error in Bun: ${error.message}. This may be due to font compatibility issues.`
  }
  if (error.message.includes("wasm") || error.message.includes("WebAssembly")) {
    return `PDF WASM error in Bun: ${error.message}. WebAssembly compatibility issue detected.`
  }

  return error.message
}
