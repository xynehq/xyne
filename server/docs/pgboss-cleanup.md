# pg-boss Queue Cleanup Guide

This document provides methods for managing and cleaning up pg-boss job queues in the sync server.

## File Processor Queue Names

The following queue names are used for file processing in Xyne:

| Queue Name | Description |
|------------|-------------|
| `file-processing` | General file processing queue |
| `file-processing-pdf` | PDF-specific file processing queue |

## Quick Start (Recommended)

A built-in bun script is available to clear file processor queues. This is the easiest and safest method.

### Clear File Processor Queues

```bash
# Navigate to server directory
cd server

# Clear file processor queues using the npm script
bun run clear:file-queue
```

### Alternative: Direct Script Execution

```bash
bun run scripts/clear-file-processor-queue.ts
```

### What the Script Does

1. Starts the pg-boss connection
2. Clears the `file-processing` queue
3. Clears the `file-processing-pdf` queue
4. Stops the pg-boss connection
5. Exits with appropriate status code

No manual setup required - the script and npm command are ready to use!

---

## Alternative Methods

If you prefer not to use the bun script, you can use SQL commands or inline bun execution.

### SQL Commands

#### View Queue Status

**View Pending Jobs in File Processor Queues:**
```sql
SELECT id, name, state, created_on, retry_count, data
FROM pgboss.job 
WHERE name IN ('file-processing', 'file-processing-pdf')
AND state = 'created'
ORDER BY created_on;
```

**View All Jobs Across All Queues:**
```sql
SELECT name, 
       state, 
       COUNT(*) as count,
       MIN(created_on) as oldest_job,
       MAX(created_on) as newest_job
FROM pgboss.job 
GROUP BY name, state
ORDER BY name, state;
```

**View Jobs by Specific State:**
```sql
-- View failed jobs
SELECT id, name, state, created_on, completed_on, retry_count, data
FROM pgboss.job 
WHERE name IN ('file-processing', 'file-processing-pdf')
AND state = 'failed'
ORDER BY created_on DESC;

-- View completed jobs
SELECT id, name, state, created_on, completed_on, data
FROM pgboss.job 
WHERE name IN ('file-processing', 'file-processing-pdf')
AND state = 'completed'
ORDER BY completed_on DESC
LIMIT 100;
```

#### Clear File Processor Queues via SQL

**Clear File Processing Queue:**
```sql
DELETE FROM pgboss.job 
WHERE name = 'file-processing';
```

**Clear PDF File Processing Queue:**
```sql
DELETE FROM pgboss.job 
WHERE name = 'file-processing-pdf';
```

**Clear Both File Processor Queues:**
```sql
DELETE FROM pgboss.job 
WHERE name IN ('file-processing', 'file-processing-pdf');
```

**Clear Only Pending (Created) Jobs:**
```sql
DELETE FROM pgboss.job 
WHERE name IN ('file-processing', 'file-processing-pdf')
AND state = 'created';
```

#### Maintenance Queries

**Clear Old Completed/Failed Jobs:**
Remove completed, failed, or cancelled jobs older than 7 days:
```sql
DELETE FROM pgboss.job 
WHERE completed_on < NOW() - INTERVAL '7 days'
AND state IN ('completed', 'failed', 'cancelled');
```

**Clear All Jobs from All Queues (Nuclear Option):**
⚠️ **Warning: This will delete ALL jobs from ALL queues. Use with caution!**
```sql
DELETE FROM pgboss.job;
```

**Reset Queue Stats:**
View job statistics by queue:
```sql
SELECT 
    name,
    COUNT(*) FILTER (WHERE state = 'created') as pending,
    COUNT(*) FILTER (WHERE state = 'retry') as retrying,
    COUNT(*) FILTER (WHERE state = 'active') as active,
    COUNT(*) FILTER (WHERE state = 'completed') as completed,
    COUNT(*) FILTER (WHERE state = 'failed') as failed,
    COUNT(*) FILTER (WHERE state = 'cancelled') as cancelled
FROM pgboss.job
GROUP BY name
ORDER BY name;
```

## Column Reference

Common pg-boss column names:

| Column | Description |
|--------|-------------|
| `id` | Unique job identifier |
| `name` | Queue name |
| `state` | Job state (created, retry, active, completed, failed, cancelled) |
| `data` | Job payload (JSON) |
| `created_on` | When job was created |
| `started_on` | When job processing started |
| `completed_on` | When job completed/failed/cancelled |
| `retry_count` | Number of retry attempts |
| `expire_in` | Job expiration interval |

## Usage Tips

1. **Use the bun script**: The `bun run clear:file-queue` command is the safest and easiest method.
2. **Always check first**: When using SQL, run a SELECT query to see what will be deleted before running DELETE.
3. **Stop the sync server**: Stop the sync server before clearing queues to avoid race conditions.
4. **Backup**: Consider backing up the database before running destructive operations.
5. **View table structure**: Use `\d pgboss.job` in psql to see all columns.
