#!/bin/sh
set -e


# Get document type from user
read -p "Enter document types to reindex (e.g., mail,file,event etc): " documentTypes

if ! command -v jq &> /dev/null; then
  echo "Error: 'jq' is required but not installed. Please install it using your package manager."
  exit 1
fi

if [ -z "$documentTypes" ]; then
  echo "Error: Document type cannot be empty"
  exit 1
fi

# # Start reindexing
vespa prepare
vespa activate

speed=8
response=$(curl -s -X POST \
"http://localhost:19071/application/v2/tenant/default/application/default/environment/default/region/default/instance/default/reindex?clusterId=my_content&documentType=$documentTypes&indexedOnly=true&speed=$speed")

if echo "$response" | grep -q '"error-code"'; then
  error_message=$(echo "$response")
  echo "Error starting reindexing: $error_message"
  exit 1
fi


success_message=$(echo "$response")
echo "Starting reindex for document type: $success_message"

vespa prepare
vespa activate

IFS=',' read -ra docTypes <<< "$documentTypes"
while true; do
    STATUS=$(curl -s "http://localhost:19071/application/v2/tenant/default/application/default/environment/default/region/default/instance/default/reindexing")
    all_successful=true
    any_error=false
    
    # Check status for each document type
    for docType in "${docTypes[@]}"; do
        STATE=$(echo "$STATUS" | jq -r --arg dt "$docType" '.clusters.my_content.ready[$dt]?.state // empty')
        
        if [ "$STATE" = "successful" ]; then
            echo "Reindexing for $docType completed successfully"
            continue
        elif [ "$STATE" = "failed" ]; then
            ERROR_MSG=$(echo "$STATUS" | jq -r --arg dt "$docType" '.clusters.my_content.ready[$dt]?.message // "Unknown error"')
            echo "ERROR: Reindexing failed for $docType - $ERROR_MSG"
            any_error=true
            all_successful=false
        elif [ "$STATE" = "pending" ]; then
            echo "Reindexing in progress for $docType"
            all_successful=false
        else
            echo "Warning: Unknown status for $docType - $STATE"
            all_successful=false
        fi
    done
    
    # Exit conditions
    if $any_error; then
        echo "Error occurred during reindexing. Exiting."
        exit 1
    fi
    
    if $all_successful; then
        echo "All document types reindexed successfully!"
        break
    fi
    
    sleep 10
done

echo "Reindex completed"