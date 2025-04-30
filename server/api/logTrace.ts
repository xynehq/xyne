import { google } from "googleapis";
import { type Context } from "hono";
import type { LogBulkTraceDataInput } from "@/api/search"; 
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";

const Logger = getLogger(Subsystem.Server);

const SHEET_ID = "1E1O_Uvk-7Oo2jj8CPEXfM3CrI3JiS_h_kZg10Ehy8cE";
const SHEET_NAME = "Sheet1";
const SERVICE_ACCOUNT_KEY_PATH = "/Users/mayank.bansal/Desktop/xyne/server/xyneChatTraceLogs.json";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// New handler for bulk logging
export const LogBulkTraceDataApi = async (c: Context) => {
  // Note: We might need to apply the specific Context typing fix here too if needed
  // @ts-ignore - Hono context typing issue with zValidator
  const body = c.req.valid("json") as LogBulkTraceDataInput;
  const traces = body.traces;

  if (!traces || traces.length === 0) {
    return c.json({ success: true, message: "No traces provided." });
  }

  Logger.info(`Received ${traces.length} traces for bulk logging.`);

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_KEY_PATH,
      scopes: SCOPES,
    });
    const sheets = google.sheets({ version: "v4", auth });

    // Map the array of trace objects to a 2D array of values for Sheets
    const values = traces.map(trace => [
      trace.title,
      trace.relevance,
      trace.nativeRankSubject,
      trace.nativeRankChunks,
      trace.vectorScore,
      new Date().toISOString(), // Add a timestamp for the bulk operation
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME, // Append after the last row of the specified sheet
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: values, // Pass the 2D array of all rows
      },
    });

    Logger.info(
      { sheetId: SHEET_ID, sheetName: SHEET_NAME, count: values.length },
      "Successfully bulk logged trace data to Google Sheet",
    );
    return c.json({ success: true, count: values.length });
  } catch (error: any) {
    Logger.error(
      { err: error, sheetId: SHEET_ID, sheetName: SHEET_NAME },
      `Failed to bulk log trace data to Google Sheet: ${error?.message}`,
    );
    return c.json(
      {
        success: false,
        error: `Failed to write bulk data to sheet: ${error?.message || 'Unknown error'}`,
      },
      500,
    );
  }
}; 