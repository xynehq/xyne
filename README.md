# Xyne

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
## Search
once you have a `.env` setup, inside root run

### Development setup
In the root folder run
```sh
docker-compose -f deployment/docker-compose.dev.yml up
```
This will start Vespa and Postgres.

Migrate the schema of Postgres
```sh
cd server
bun i
bun run generate
bun run migrate
```

Add Vespa schema and download embedding models
```sh
cd vespa
./deploy.sh
```

Now start the server.
For the watch mode
```sh
bun run dev
```

```sh
cd frontend
bun i
bun run dev
```


### Build Xyne image
```sh 
docker build -t xyne .
```

### Deployment
