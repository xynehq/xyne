set -e


vespa feed -t http://localhost:8080 tests/data/eventVespaProcessed.json
vespa feed -t http://localhost:8080 tests/data/emailVespaProcessed.json
vespa feed -t http://localhost:8080 tests/data/fileVespaProcessed.json
vespa feed -t http://localhost:8080 tests/data/peopleVespaProcessed.json