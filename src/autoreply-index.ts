import { AUTOREPLY_HOST, AUTOREPLY_PORT } from './autoreply-env.js'
import { startAutoReplyServer } from './autoreply-server.js'
import { startTaskRunner } from './tasks-runner.js'

startAutoReplyServer()
  .then(() => {
    console.log(`[autoreply] listening on http://${AUTOREPLY_HOST}:${AUTOREPLY_PORT}`)
    startTaskRunner()
  })
  .catch((err: unknown) => {
    console.error('[autoreply] failed to start', err)
    process.exit(1)
  })
