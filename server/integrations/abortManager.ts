// this is the global abort map for all the ongoing ingestions
// when from the frontend we get signal to pause or stop
// we will use this map to abort the ongoing ingestion for that app
export const globalAbortControllers = new Map<string, AbortController>()
