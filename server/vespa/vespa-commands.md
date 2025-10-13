# Vespa Useful Commands

## Data Management

### Delete All Documents from Specific Document Type
```bash
# Delete all jql_query documents
curl -X DELETE "http://localhost:8080/document/v1/my_content/jql_query/docid?cluster=my_content&selection=true"

# Delete all user documents  
curl -X DELETE "http://localhost:8080/document/v1/my_content/user/docid?cluster=my_content&selection=true"

# Delete all file documents
curl -X DELETE "http://localhost:8080/document/v1/my_content/file/docid?cluster=my_content&selection=true"

# Delete all mail documents
curl -X DELETE "http://localhost:8080/document/v1/my_content/mail/docid?cluster=my_content&selection=true"
```

### Check Document Count
```bash
# Count jql_query documents
curl "http://localhost:8080/search/?yql=select%20*%20from%20jql_query&hits=0&summary=count"

# Count all documents in cluster
curl "http://localhost:8080/search/?yql=select%20*%20from%20sources%20*&hits=0&summary=count"
```

### Visit Documents (Browse Data)
```bash
# Visit all documents
vespa visit

# Visit specific document type
vespa visit --document-type jql_query

# Visit with limits
vespa visit --max-hits 10
```

### Dump Documents (Export Data)
```bash
# Dump all documents from cluster to JSON feed format
vespa visit --content-cluster my_content --make-feed > dump.json

# Dump specific document type (schema-wise)
vespa visit --content-cluster my_content --document-type jql_query --make-feed > jql_query_dump.json
vespa visit --content-cluster my_content --document-type user --make-feed > user_dump.json
vespa visit --content-cluster my_content --document-type file --make-feed > file_dump.json
vespa visit --content-cluster my_content --document-type mail --make-feed > mail_dump.json
vespa visit --content-cluster my_content --document-type event --make-feed > event_dump.json
vespa visit --content-cluster my_content --document-type chat_message --make-feed > chat_message_dump.json

# Dump with progress tracking
vespa visit --content-cluster my_content --make-feed --progress > full_dump.json

# Dump specific selection (filtered)
vespa visit --content-cluster my_content --selection "jql_query and id contains 'A.'" --make-feed > filtered_dump.json

# Dump with field projection (only specific fields)
vespa visit --content-cluster my_content --document-type jql_query --field-set "id,nlq,jql" --make-feed > minimal_dump.json
```

## Deployment & Configuration

### Deploy Application
```bash
# Deploy with wait
vespa deploy --wait 960 --target http://${VESPA_HOST}:19071

# Quick deploy
vespa deploy
```

### Reindex Documents
```bash
# Reindex specific document type
./reindex.sh
# Then enter: jql_query

# Or direct API call
curl -X POST "http://localhost:19071/application/v2/tenant/default/application/default/environment/default/region/default/instance/default/reindex?clusterId=my_content&documentType=jql_query&indexedOnly=true&speed=8"
```

## Search & Query

### Basic Search
```bash
# Search jql_query documents
curl "http://localhost:8080/search/?yql=select%20*%20from%20jql_query&hits=10"

# Search with text query
curl "http://localhost:8080/search/?yql=select%20*%20from%20jql_query%20where%20userQuery%20contains%20%22bug%22&hits=10"
```

### Advanced Search with Ranking
```bash
# Search with hybrid ranking (text + vector)
curl -X POST "http://localhost:8080/search/" \
  -H "Content-Type: application/json" \
  -d '{
    "yql": "select * from jql_query where ({targetHits:15}nearestNeighbor(query_embedding, embedding)) or userQuery contains \"your query\"",
    "ranking": "hybrid",
    "input.query(query_text)": "your search query",
    "hits": 15
  }'
```

## Document Operations

### Insert Single Document
```bash
curl -X POST "http://localhost:8080/document/v1/my_content/jql_query/docid/test-1" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "id": "test-1",
      "nlq": "test query",
      "jql": "status = Open",
      "entities": "{\"status\": \"Open\"}"
    }
  }'
```

### Get Single Document
```bash
curl "http://localhost:8080/document/v1/my_content/jql_query/docid/test-1"
```

### Delete Single Document
```bash
curl -X DELETE "http://localhost:8080/document/v1/my_content/jql_query/docid/test-1"
```

## Status & Health

### Check Cluster Status
```bash
curl "http://localhost:19071/application/v2/tenant/default/application/default/environment/default/region/default/instance/default/serviceconverge"
```

### Check Node Status
```bash
curl "http://localhost:8080/state/v1/health"
```

### Check Reindexing Status
```bash
curl "http://localhost:19071/application/v2/tenant/default/application/default/environment/default/region/default/instance/default/reindexing"
```

## Data Ingestion Scripts

### Run JQL Data Insertion
```bash
# From server directory
npx tsx scripts/insertJQLQueries.ts
```

### Clear All JQL Data (Script)
```bash
node scripts/clearVespaData.js
```

## Notes

- Replace `${VESPA_HOST}` with your actual Vespa host (usually `localhost`)
- Port 8080: Search and Document API
- Port 19071: Config Server API  
- Always use proper JSON escaping in curl commands
- Use `jq` for pretty-printing JSON responses: `| jq`