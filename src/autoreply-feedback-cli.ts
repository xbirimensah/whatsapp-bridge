import { listFeedback, recordFeedback, type FeedbackOutcome } from './autoreply-feedback.js'
import { AUTOREPLY_DEFAULT_SESSION } from './autoreply-env.js'

function usage(): never {
  throw new Error('usage: autoreply:feedback list [limit] | add <chat_jid> <draft_reply> <correction> [accepted|corrected|rejected] [note]')
}

const [command, ...args] = process.argv.slice(2)
if (command === 'list') {
  process.stdout.write(`${JSON.stringify(listFeedback(args[0] ? Number(args[0]) : 50), null, 2)}\n`)
} else if (command === 'add') {
  const [chat_jid, draft_reply, correction, rawOutcome = 'corrected', note] = args
  if (!chat_jid || !draft_reply || !correction || !['accepted', 'corrected', 'rejected'].includes(rawOutcome)) usage()
  const entry = recordFeedback({
    session: AUTOREPLY_DEFAULT_SESSION,
    chat_jid,
    message_id: null,
    draft_reply,
    correction,
    outcome: rawOutcome as FeedbackOutcome,
    note: note ?? null,
  })
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
} else {
  usage()
}
