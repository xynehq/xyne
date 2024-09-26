# Xyne

## Search
once you have a `.env` setup, inside root run

### Development setup
In the root folder run
```sh
$ docker-compose -f deployment/docker-compose.dev.yml up
```
This will start Vespa and Postgres.

Migrate the schema of Postgres
```sh
$ cd server
$ bun i
$ bun run generate
$ bun run migrate
```

Add Vespa schema
```sh
$ cd vespa
$ ./deploy.sh
```

Now start the server.
For the watch mode
```sh
$ bun run dev
```
or 
```sh
$ bun run server.ts
```


### Build Xyne image
```sh 
docker build -t xyne .
```

```sh
$ cd frontend
$ bun i
$ bun run dev
```

Initially server will need to download the embedding model.
