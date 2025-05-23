import { type Context } from "hono";
import type { LogBulkTraceDataInput } from "@/api/search";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";

const Logger = getLogger(Subsystem.Server);

// Remove Google Sheets constants
// const SHEET_ID = "1E1O_Uvk-7Oo2jj8CPEXfM3CrI3JiS_h_kZg10Ehy8cE";
// const SHEET_NAME = "Sheet1";
// New handler for bulk logging
export const LogBulkTraceDataApi = async (c: Context) => {
  // Note: We might need to apply the specific Context typing fix here too if needed
  // @ts-ignore - Hono context typing issue with zValidator
  const body = c.req.valid("json") as LogBulkTraceDataInput;
  const traces = body.traces;

  if (!traces || traces.length === 0) {
    return c.json({ success: true, message: "No traces provided." });
  }

  Logger.info(`Received ${traces.length} traces for CSV export.`);

  try {
    // Define CSV headers
    const headers = [
      "Title",
      "Relevance",
      "NativeRankSubject",
      "NativeRankChunks",
      "VectorScore",
      "NativeRankEmail",
      "NativeRankName",
      "NativeRankFilename",
      "NativeRankTitle",
      "NativeRankUrl",
      "NativeRankAttachmentFilenames",
      "NativeRankDescription",
      "NativeRankAttendeesNames",
      "Timestamp",
    ];

    // Map the array of trace objects to CSV rows
    const csvRows = traces.map(trace => [
      trace.title,
      trace.relevance,
      trace.nativeRankSubject,
      trace.nativeRankChunks,
      trace.vectorScore,
      trace.nativeRankEmail,
      trace.nativeRankName,
      trace.nativeRankFilename,
      trace.nativeRankTitle,
      trace.nativeRankUrl,
      trace.nativeRankAttachmentFilenames,
      trace.nativeRankDescription,
      trace.nativeRankAttendeesNames,
      new Date().toISOString(),
    ]);

    // Combine headers and rows into a CSV string
    const csvContent = [
      headers.join(","),
      ...csvRows.map(row => row.map(field => `"${String(field ?? '').replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    const filename = `trace_data_${new Date().toISOString().split('T')[0]}.csv`;

    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    
    Logger.info(
      { count: traces.length, filename: filename },
      "Successfully generated CSV for trace data",
    );
    // The CSV content is sent as the response body to the client.
    // The client (e.g., a browser) will handle this as a file download.
    // The file is not saved on the server by this function.
    return c.body(csvContent);

  } catch (error: any) {
    Logger.error(
      { err: error },
      `Failed to generate CSV for trace data: ${error?.message}`,
    );
    return c.json(
      {
        success: false,
        error: `Failed to generate CSV: ${error?.message || 'Unknown error'}`,
      },
      500,
    );
  }
};
