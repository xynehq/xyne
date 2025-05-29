#!/bin/bash

echo "Checking Vespa health..."
curl http://localhost:8080/ApplicationStatus
echo ""

echo "Checking schema endpoints..."
curl http://localhost:8080/document/v1/
