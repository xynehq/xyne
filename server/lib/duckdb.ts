import { Database } from "duckdb-async";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import type { DuckDBResult } from "@/types";
import { analyzeQueryAndGenerateSQL } from "./sqlInference";
import { writeFileSync, unlinkSync, createWriteStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const Logger = getLogger(Subsystem.Integrations).child({
  module: "duckdb",
});

// Simple SQL validation function
function validateSQL(sql: string): void {
  const disallowedKeywords = [
    'INSTALL', 'LOAD', 'PRAGMA', 'COPY', 'EXPORT', 'ATTACH', 'DETACH', 
    'CALL', 'CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 
    'SET', 'RESET'
  ];
  
  const upperSQL = sql.toUpperCase();
  
  for (const keyword of disallowedKeywords) {
    if (upperSQL.includes(keyword)) {
      throw new Error(`Disallowed SQL keyword detected: ${keyword}`);
    }
  }
  
  // Ensure it's a SELECT statement
  if (!upperSQL.trim().startsWith('SELECT')) {
    throw new Error('Only SELECT statements are allowed');
  }
  
  // Ensure there's a LIMIT clause
  if (!upperSQL.includes('LIMIT')) {
    throw new Error('LIMIT clause is required for all queries');
  }
}

export const querySheetChunks = async (
  sheetChunks: string[],
  userQuery: string,
): Promise<DuckDBResult | null> => {
  if (!sheetChunks.length) {
    return null;
  }

  Logger.debug("Processing sheet chunks with DuckDB");

  // Clean HTML tags from sheet chunks
  const cleanedSheetChunks = sheetChunks.map(chunk => 
    chunk.replace(/<\/?hi>/g, '')
  );

  // Create a temporary CSV file using streaming for large data
  const tempFilePath = join(tmpdir(), `duckdb_temp_${Date.now()}.tsv`);
  Logger.debug(`Writing ${cleanedSheetChunks.length} chunks to temporary file: ${tempFilePath}`);
  
  if (cleanedSheetChunks.length > 100) {
    // Use streaming for large datasets
    const ws = createWriteStream(tempFilePath, { encoding: "utf8" });
    for (const chunk of cleanedSheetChunks) {
      ws.write(chunk);
      ws.write('\n');
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.end();
    });
    Logger.debug("Large dataset written using streaming");
  } else {
    // Use simple write for small datasets
    const combinedData = cleanedSheetChunks.join('\n');
    writeFileSync(tempFilePath, combinedData);
    Logger.debug("Small dataset written using simple write");
  }

  // Use on-disk DB and tune pragmas for large files
  const db = await Database.create(join(tmpdir(), `xyne_${Date.now()}.duckdb`));
  const connection = await db.connect();
  
  Logger.debug("Setting up DuckDB pragmas for large file processing");
  await connection.run(`PRAGMA temp_directory='${tmpdir()}'`);
  await connection.run(`PRAGMA threads=${Math.max(1, Math.floor(require('os').cpus().length / 2))}`);
  await connection.run(`PRAGMA memory_limit='4GB'`);

  const tableName = `v_${Date.now().toString(36)}`;
  const startTime = Date.now();

  try {
    Logger.debug(`Creating VIEW ${tableName} over CSV file: ${tempFilePath}`);
    
    // 1) Create a VIEW over the CSV (no materialization)
    const escapedPath = tempFilePath.replace(/'/g, "''");
    Logger.debug(`Escaped path: ${escapedPath}`);
    
    try {
      await connection.run(`
        CREATE OR REPLACE VIEW ${tableName} AS
        SELECT * FROM read_csv(
          '${escapedPath}',
          delim='\t', 
          header=true, 
          quote='"',
          escape='"',
          null_padding=true,
          ignore_errors=true,
          strict_mode=false,
          sample_size=100000
        )
      `);
      Logger.debug(`VIEW ${tableName} created successfully`);
    } catch (viewError) {
      console.error(`Failed to create VIEW ${tableName}:`, viewError);
      throw viewError;
    }

    // 2) Get schema without loading all rows
    Logger.debug(`Getting schema for ${tableName}`);
    const schemaResult = await connection.all(`DESCRIBE ${tableName}`);
    const schema = schemaResult
      .map((col: any) => `${col.column_name}: ${col.column_type}`)
      .join('\n');
    Logger.debug(`Schema obtained: ${schema}`);

    // 3) Get sample rows from the source (small scan only)
    Logger.debug(`Getting sample rows from ${tableName}`);
    const sampleRowsRes = await connection.all(
      `SELECT * FROM ${tableName} LIMIT 5`
    );
    Logger.debug(`Sample rows obtained: ${sampleRowsRes.length} rows`);
    
    // Build sample rows text for prompt
    const sampleRowsHeader = schemaResult.map((c: any) => c.column_name).join('\t');
    const sampleRowsBody = sampleRowsRes
      .map((r: any) => schemaResult.map((c: any) => String(r[c.column_name] ?? '')).join('\t'))
      .join('\n');
    const sampleRows = `${sampleRowsHeader}\n${sampleRowsBody}`;
    Logger.debug(`Sample rows text prepared: ${sampleRows.length} characters`);
    
    // 4) Generate SQL using the schema + samples
    Logger.debug(`Generating SQL for query: ${userQuery}`);
    const duckDBQuery = await analyzeQueryAndGenerateSQL(
      userQuery,
      tableName,
      schema,
      sampleRows,
    );
    
    if (!duckDBQuery) {
      Logger.warn("Failed to generate DuckDB query, returning null");
      return null;
    }
    Logger.debug(`Generated SQL: ${duckDBQuery.sql}`);

    // 5) Validate and run
    Logger.debug("Validating generated SQL");
    validateSQL(duckDBQuery.sql);
    
    Logger.debug(`Executing DuckDB query: ${duckDBQuery.sql}`);
    const result = await connection.all(duckDBQuery.sql);
    const elapsedMs = Date.now() - startTime;
    Logger.debug(`Query executed successfully, returned ${result.length} rows in ${elapsedMs}ms`);

    if (result.length === 0) {
      Logger.warn("DuckDB query returned no results, returning null");
      return null;
    }

    const columns = Object.keys(result[0] ?? {});
    const rows = [columns, ...result.map((row: any) => Object.values(row))];

    const resultPackage: DuckDBResult = {
      user_question: userQuery,
      sql: duckDBQuery.sql,
      execution_meta: {
        row_count: result.length,
        elapsed_ms: elapsedMs,
        as_of: new Date().toISOString(),
      },
      schema_fragment: {
        table: tableName, // it's a VIEW
        columns: schemaResult.reduce((acc: Record<string,string>, col: any) => {
          acc[col.column_name] = col.column_type;
          return acc;
        }, {}),
      },
      assumptions: [duckDBQuery.notes],
      data: { rows },
    };

    Logger.debug("DuckDB processing completed successfully");
    return resultPackage;
  } catch (error) {
    Logger.error("Error querying with DuckDB:", error);
    return null;
  } finally {
    // Clean up
    Logger.debug("Cleaning up DuckDB resources");
    try {
      await connection.close();
      await db.close();
      Logger.debug("DuckDB connection and database closed");
    } catch (e) {
      Logger.warn("Error closing DuckDB resources:", e);
    }
    
    // Clean up temporary file
    try {
      unlinkSync(tempFilePath);
      Logger.debug(`Temporary file deleted: ${tempFilePath}`);
    } catch (e) {
      Logger.warn(`Failed to delete temporary file ${tempFilePath}:`, e);
    }
  }
};
