import  {getLogger, middlewareLogger} from './logger'
import { LOGGERTYPES } from './types'
import { Hono, type Context } from 'hono'
const app = new Hono()


//const logger = getLogger(LOGGERTYPES.api).child({module: "foo"}).child({b : "hello"}).error({err: new Error("An Error")}, "Hi there!")

app.use('*', middlewareLogger(LOGGERTYPES.api) )
app.get('/', (c: Context) => { return c.text('Hello World')})

export default app;