// Punto de entrada: conecta con WhatsApp y arranca el bot.
//   npm start                          -> muestra un QR para escanear
//   npm start -- --numero 5215512345678 -> en vez de QR, da un código de 8 letras
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, proto, useMultiFileAuthState } from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { createBot } from './bot.js'
import config from './config.js'

if (!('audioStickerMessage' in proto.Message.prototype)) {
	console.error('Falta el parche de Baileys para stickers con sonido. Ejecuta: npx patch-package  (o usa npm start)')
	process.exit(1)
}

// Logger simple y legible para la consola (acepta el estilo de pino: log.info({ err }, 'texto'))
const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => {
	const [data, msg] = typeof args[0] === 'string' ? [undefined, args[0]] : args
	const out = level === 'info' ? console.log : console[level]
	out(`[${new Date().toLocaleTimeString()}] ${msg ?? ''}`)
	if (data?.err) out(data.err.stack || data.err)
	else if (data) out(JSON.stringify(data, null, 2))
}]))
// Baileys es muy hablador; solo mostramos sus errores
const baileysLog = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' })

const numeroIdx = process.argv.indexOf('--numero')
const pairingNumber = (numeroIdx !== -1 ? process.argv[numeroIdx + 1] : process.env.NUMERO || '').replace(/\D/g, '')

// Mensajes enviados por el bot: para no procesarlos y para reenviarlos si un
// dispositivo pide reintento (getMessage)
const sent = new Map()
function rememberSent(msg) {
	if (!msg?.key?.id) return
	sent.set(msg.key.id, msg.message)
	if (sent.size > 500) sent.delete(sent.keys().next().value)
}
const isSentByBot = (id) => sent.has(id)

async function start() {
	const { state, saveCreds } = await useMultiFileAuthState(config.authFolder)
	const { version } = await fetchLatestBaileysVersion().catch(() => ({}))

	const sock = makeWASocket({
		version,
		auth: state,
		logger: baileysLog,
		browser: Browsers.windows('Chrome'),
		markOnlineOnConnect: false, // para que te sigan llegando notificaciones al celular
		syncFullHistory: false,
		getMessage: async (key) => sent.get(key.id)
	})

	sock.ev.on('creds.update', saveCreds)

	let pairingRequested = false
	sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
		if (qr) {
			if (pairingNumber && !pairingRequested) {
				pairingRequested = true
				try {
					const code = await sock.requestPairingCode(pairingNumber)
					log.info(`Código de vinculación: ${code.match(/.{1,4}/g).join('-')}`)
					log.info('En tu celular: WhatsApp > Dispositivos vinculados > Vincular dispositivo > Vincular con número de teléfono')
				} catch (err) {
					log.error({ err }, 'No pude pedir el código de vinculación')
				}
			} else if (!pairingNumber) {
				qrcode.generate(qr, { small: true })
				log.info('Escanea el QR: WhatsApp > Dispositivos vinculados > Vincular dispositivo')
			}
		}

		if (connection === 'open') {
			log.info(`✅ Conectado como ${sock.user?.id}. Escribe ${config.prefix}menu en cualquier chat (por ejemplo en tu chat contigo mismo).`)
		}

		if (connection === 'close') {
			const status = lastDisconnect?.error?.output?.statusCode
			if (status === DisconnectReason.loggedOut) {
				log.error(`Se cerró la sesión. Borra la carpeta "${config.authFolder}" y vuelve a ejecutar npm start para vincular de nuevo.`)
				process.exit(1)
			}
			log.warn(`Conexión cerrada (código ${status ?? 'desconocido'}). Reconectando...`)
			setTimeout(() => start().catch((err) => log.error({ err }, 'Error al reconectar')), 2000)
		}
	})

	createBot(sock, { log, rememberSent, isSentByBot })
}

start().catch((err) => {
	log.error({ err }, 'Error al iniciar')
	process.exit(1)
})
