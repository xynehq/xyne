import { Database } from "duckdb-async";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import type { DuckDBResult } from "@/types";
import { analyzeQueryAndGenerateSQL } from "./sqlInference";
import { writeFileSync, unlinkSync, createWriteStream, promises as fs } from "fs";
import { join } from "path";
import { tmpdir, cpus } from "os";

const Logger = getLogger(Subsystem.Integrations).child({
  module: "duckdb",
});

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
  const tmpDir = tmpdir().replace(/'/g, "''");
  const tempFilePath = join(tmpDir, `duckdb_temp_${Date.now()}.tsv`);
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
  const dbPath = join(tmpDir, `xyne_${Date.now()}.duckdb`);
  const db = await Database.create(dbPath);
  const connection = await db.connect();
  
  Logger.debug("Setting up DuckDB pragmas for large file processing");
  await connection.run(`PRAGMA temp_directory='${tmpDir}'`);
  await connection.run(`PRAGMA threads=${Math.max(1, Math.floor(cpus().length / 2))}`);
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
      Logger.error(`Failed to create VIEW ${tableName}:`, viewError);
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
      if (connection) await connection.close();
      if (db) await db.close();
      Logger.debug("DuckDB connection and database closed");
    } catch (e) {
      Logger.warn("Error closing DuckDB resources:", e);
    }
    
    // Clean up temporary TSV file
    try {
      unlinkSync(tempFilePath);
      Logger.debug(`Temporary TSV file deleted: ${tempFilePath}`);
    } catch (e) {
      Logger.warn(`Failed to delete temporary TSV file ${tempFilePath}:`, e);
    }
    
    // Clean up temporary DuckDB file
    try {
      await fs.stat(dbPath);
      await fs.unlink(dbPath);
      Logger.debug(`Temporary DuckDB file deleted: ${dbPath}`);
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
        Logger.debug(`Temporary DuckDB file already removed: ${dbPath}`);
      } else {
        Logger.warn(`Failed to delete temporary DuckDB file ${dbPath}:`, e);
      }
    }
  }
};
