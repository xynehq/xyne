### Run Docs locally

```js
bunx mintlify dev
```

### Run server in Node

To run the server in Node instead of Bun, do the following:
- Follow every step as it is except the step of starting the server.
- Inside of the `server` folder, instead of running `bun run dev`
run 
```js
bun run build:server
```
which will convert the Typescript server files into Javascript files in the distServer folder.
- After that run 
```js
bun run nodeServer
```
command which will start the server using Node.