# Xyne

## Search
once you have a .env setup, inside root run

### Development setup
In the root folder run
```sh
$  docker-compose -f deployment/docker-compose.dev.yml up
```
This will start Vespa and Postgres.

`cd server`

Migrate the schema of Postgres
```sh
$ bun i
```
```sh 
$ bun run generate
```
```sh
$ bun run migrate
```

Add Vespa schema
`cd vespa`

```sh
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
`cd ../frontend`
```sh
$ bun i
```
```sh
$ bun run dev
```

Initially server will need to download the embedding model.
