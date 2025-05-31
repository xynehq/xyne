import { Apps, DriveEntity } from "@/search/types";
import { chunkDocument } from "@/chunks";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import { insertWithRetry } from "@/search/vespa";
import { transcriptSchema } from "@/search/types";

const Logger = getLogger(Subsystem.Integrations).child({ module: "transcript" });

// Type for the processed transcript
interface ProcessedTranscript {
  docId: string;
  title: string;
  description: string;
  fileName: string;
  fileSize: number;
  chunks: string[];
  uploadedBy: string;
  duration: number;
  mimeType: string;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  app: Apps;
}

// Process the transcript content
const processTranscriptContent = (content: string, filename: string, userEmail: string, fileSize: number): ProcessedTranscript => {
  // Clean and chunk the content
  const chunks = chunkDocument(content).map(v => v.chunk);
  
  const now = Date.now();
  
  return {
    docId: `transcript_${now}`,
    title: filename,
    description: "Uploaded transcript",
    app: Apps.Transcript,
    fileName: filename,
    fileSize,
    chunks,
    uploadedBy: userEmail,
    duration: 0, // TODO: Add duration calculation if needed
    mimeType: "text/plain",
    metadata: "{}",
    createdAt: now,
    updatedAt: now
  };
};

// Main function to handle transcript upload
export const handleTranscriptUpload = async (file: File, userEmail: string) => {
  try {
    if (!file) {
      throw new Error("No file uploaded");
    }

    // Convert file to text
    const content = await file.text();
    
    // Process the transcript
    const processedTranscript = processTranscriptContent(content, file.name, userEmail, file.size);
    console.log("Processed Transcript:", processedTranscript);
    // Store in Vespa
    await insertWithRetry(processedTranscript, transcriptSchema);
    
    return { 
      success: true, 
      message: "Transcript processed successfully",
      docId: processedTranscript.docId 
    };
    
  } catch (error) {
    Logger.error(error, "Error processing transcript");
    throw error;
  }
};
