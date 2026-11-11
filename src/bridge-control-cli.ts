import './env.js'

import { API_TOKEN, PORT } from './env.js'

const choice = process.argv[2]?.trim().toLowerCase()
if (choice !== 'on' && choice !== 'off') {
  console.error('usage: npm run bridge:control -- on|off')
  process.exit(2)
}

const response = await fetch(`http://127.0.0.1:${PORT}/v1/bridge/control`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ enabled: choice === 'on' }),
})

const body = await response.text()
if (!response.ok) {
  console.error(`bridge control failed: HTTP ${response.status}`)
  process.exit(1)
}
console.log(body)
