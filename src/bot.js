// Lógica de comandos del bot.
import { downloadContentFromMessage, getContentType, normalizeMessageContent } from 'baileys'
import config from './config.js'
import { downloadFromLink, findUrl } from './download.js'
import { addStickerExif } from './exif.js'
import { imageToSticker, isAnimatedWebp, probeBuffer, toStickerAudio, videoToSticker } from './media.js'
import { getSoundStickerParts, sendSoundSticker } from './soundSticker.js'

const MAX_MESSAGE_AGE_S = 120
const VISUAL_KINDS = new Set(['image', 'video', 'sticker'])

// Stickers con sonido a medias, por chat y persona: { visual?, audio?, start, expires }
const pending = new Map()

const MENU = `*🤖 Bot de stickers*

*${config.prefix}s* — sticker normal
  Responde a una imagen, video, GIF o *link de TikTok* con ${config.prefix}s (o mándalo con ${config.prefix}s de texto).

*${config.prefix}ss* — sticker con sonido 🔊
  • Responde a un *video* con ${config.prefix}ss → sticker animado con el audio del video.
  • Responde a un *link de TikTok* con ${config.prefix}ss, o escribe ${config.prefix}ss <link>.
  • Responde a una *imagen o sticker* con ${config.prefix}ss y luego manda el *audio, nota de voz o link*.
  • O al revés: responde a un *audio* con ${config.prefix}ss y luego manda la imagen.
  • ${config.prefix}ss 3 → el audio empieza en el segundo 3.
  Máximo ${config.maxAudioSeconds} s de audio.
  Los links también pueden ser de Instagram, YouTube Shorts, X, etc.

*1:1* — agrégalo a ${config.prefix}s o ${config.prefix}ss para recortar cuadrado al centro
  Ej.: ${config.prefix}s 1:1 · ${config.prefix}ss 1:1 <link> · ${config.prefix}ss 3 1:1
  (también sirve escribir *cuadrado*)

*${config.prefix}audio* — responde a un sticker con sonido para sacar su audio
*${config.prefix}info* — responde a un mensaje para ver cómo viene por dentro
*${config.prefix}cancelar* — cancela un sticker con sonido a medias`

export function createBot(sock, { log, rememberSent, isSentByBot }) {
	sock.ev.on('messages.upsert', ({ messages, type }) => {
		// 'notify' = mensajes nuevos (incluidos los que escribes tú desde el celular).
		// 'append' = copias de lo que envía el propio bot o mensajes viejos: se ignoran.
		if (type !== 'notify') return
		for (const m of messages) {
			handleMessage(m).catch((err) => log.error({ err }, 'Error procesando mensaje'))
		}
	})

	async function handleMessage(m) {
		if (!m.message || isSentByBot(m.key.id)) return
		const age = Date.now() / 1000 - Number(m.messageTimestamp || 0)
		if (age > MAX_MESSAGE_AGE_S) return

		const chat = m.key.remoteJid
		const content = normalizeMessageContent(m.message)
		const text = getText(content).trim()
		const isCommand = text.startsWith(config.prefix)

		if (!isOwner(m.key)) {
			if (isCommand) log.info(`Comando ignorado de ${senderOf(m.key)} (no está en "owners" de src/config.js)`)
			return
		}

		const key = pendingKey(m)
		if (!isCommand) {
			// ¿Completa un sticker con sonido pendiente?
			if (pending.has(key)) await continuePending(m, chat, key, content, text)
			return
		}

		const [rawCmd, ...args] = text.slice(config.prefix.length).trim().split(/\s+/)
		const cmd = (rawCmd || '').toLowerCase()
		const quoted = getQuoted(content)

		try {
			switch (cmd) {
				case 'menu':
				case 'ayuda':
				case 'help':
					return await reply(chat, MENU)
				case 's':
				case 'sticker':
					return await cmdSticker(m, chat, content, quoted, args)
				case 'ss':
				case 'sonido':
				case 'stickersonido':
					return await cmdSoundSticker(m, chat, key, content, quoted, args)
				case 'audio':
					return await cmdExtractAudio(m, chat, quoted)
				case 'info':
					return await cmdInfo(chat, quoted ? getQuotedRaw(content) : m.message)
				case 'cancelar':
					pending.delete(key)
					return await reply(chat, '❎ Cancelado.')
				default:
					return // comando desconocido: no decir nada
			}
		} catch (err) {
			log.error({ err }, `Error en ${config.prefix}${cmd}`)
			await react(m, '❌')
			await reply(chat, `❌ No pude hacerlo: ${err.message}`)
		}
	}

	// ---------- !s ----------
	async function cmdSticker(m, chat, content, quoted, args) {
		let media = findMedia(content) || findMedia(quoted)
		if (media?.kind === 'audio') media = null
		const url = media ? null : linkFrom(args, quoted)
		if (!media && !url) {
			return reply(chat, `Responde a una imagen, video, GIF o link de TikTok con *${config.prefix}s*.`)
		}
		await react(m, '⏳')
		const squareCrop = parseSquare(args)
		let buffer
		if (url) {
			const dl = await downloadFromLink(url)
			if (!dl.hasVideo) throw new Error('Ese link no trae video.')
			media = { kind: 'video' }
			buffer = dl.buffer
		} else {
			buffer = await download(media)
		}
		let webp
		let animated
		if (media.kind === 'sticker') {
			webp = buffer // re-envía el sticker (sin sonido)
			animated = isAnimatedWebp(buffer)
		} else if (media.kind === 'image') {
			webp = await addExif(await imageToSticker(buffer, { square: squareCrop === 'always' }))
			animated = false
		} else {
			webp = await addExif(await videoToSticker(buffer, { maxSeconds: config.maxVideoSeconds, squareCrop }))
			animated = true
		}
		rememberSent(await sock.sendMessage(chat, { sticker: webp, isAnimated: animated }))
		await react(m, '✅')
	}

	// ---------- !ss ----------
	async function cmdSoundSticker(m, chat, key, content, quoted, args) {
		const start = parseStart(args)
		const sources = [findMedia(content), findMedia(quoted)].filter(Boolean)
		const job = { start, squareCrop: parseSquare(args), expires: Date.now() + config.pendingTimeoutMs }

		const visualSrc = sources.find((s) => VISUAL_KINDS.has(s.kind))
		const audioSrc = sources.find((s) => s.kind === 'audio')
		const url = visualSrc ? null : linkFrom(args, quoted)

		if (!visualSrc && !audioSrc && !url) {
			return reply(chat,
				`Responde con *${config.prefix}ss* a un video, imagen, sticker, audio o link de TikTok.\n` +
				`Escribe *${config.prefix}menu* para ver cómo funciona.`)
		}

		await react(m, '⏳')
		if (visualSrc) job.visual = { kind: visualSrc.kind, buffer: await download(visualSrc) }
		if (audioSrc) job.audio = { buffer: await download(audioSrc) }
		if (url) await addLinkToJob(job, url)

		// Un video con audio sirve para las dos cosas
		if (job.visual?.kind === 'video' && !job.audio) {
			const info = await probeBuffer(job.visual.buffer)
			if (info.hasAudio) job.audio = { buffer: job.visual.buffer, fromVideo: true }
		}

		if (job.visual && job.audio) return buildAndSend(m, chat, job)

		pending.set(key, job)
		await react(m, '👍')
		if (job.visual) {
			await reply(chat, `🖼️ Listo. Ahora manda el *audio, nota de voz o link* (máx. ${config.maxAudioSeconds} s).\n${config.prefix}cancelar para cancelar.`)
		} else {
			await reply(chat, `🔊 Listo. Ahora manda la *imagen, sticker, video o link* para el sticker.\n${config.prefix}cancelar para cancelar.`)
		}
	}

	async function continuePending(m, chat, key, content, text) {
		const job = pending.get(key)
		if (Date.now() > job.expires) {
			pending.delete(key)
			return
		}
		const media = findMedia(content)
		const url = media ? null : findUrl(text)
		if (!media && !url) return

		try {
			if (url) {
				await react(m, '⏳')
				await addLinkToJob(job, url)
			} else if (!job.audio && (media.kind === 'audio' || media.kind === 'video')) {
				const buffer = await download(media)
				if (media.kind === 'video' && !(await probeBuffer(buffer)).hasAudio) {
					return await reply(chat, '🔇 Ese video no tiene audio. Manda un audio o nota de voz.')
				}
				job.audio = { buffer }
			} else if (!job.visual && VISUAL_KINDS.has(media.kind)) {
				job.visual = { kind: media.kind, buffer: await download(media) }
			} else {
				return
			}

			if (job.visual && job.audio) {
				pending.delete(key)
				await buildAndSend(m, chat, job)
			}
		} catch (err) {
			log.error({ err }, 'Error creando sticker con sonido')
			await react(m, '❌')
			await reply(chat, `❌ No pude hacerlo: ${err.message}`)
		}
	}

	/** Descarga el link y lo usa para lo que le falte al sticker (video o audio). */
	async function addLinkToJob(job, url) {
		const dl = await downloadFromLink(url)
		if (!job.visual && dl.hasVideo) job.visual = { kind: 'video', buffer: dl.buffer }
		else if (!job.audio && dl.hasAudio) job.audio = { buffer: dl.buffer }
		else throw new Error(job.visual ? 'Ese link no trae audio.' : 'Ese link no trae video.')
	}

	async function buildAndSend(m, chat, { visual, audio, start, squareCrop }) {
		await react(m, '⏳')
		let webp
		let animated
		if (visual.kind === 'sticker') {
			webp = visual.buffer
			animated = isAnimatedWebp(webp)
		} else if (visual.kind === 'image') {
			webp = await addExif(await imageToSticker(visual.buffer, { square: squareCrop === 'always' }))
			animated = false
		} else {
			webp = await addExif(await videoToSticker(visual.buffer, { start, maxSeconds: config.maxVideoSeconds, squareCrop }))
			animated = true
		}

		// Si el audio sale del mismo video, que dure lo mismo que la animación
		const maxSeconds = audio.fromVideo ? Math.min(config.maxVideoSeconds, config.maxAudioSeconds) : config.maxAudioSeconds
		const sound = await toStickerAudio(audio.buffer, { start, maxSeconds, format: config.audioFormat })

		rememberSent(await sendSoundSticker(sock, chat, { webp, animated, audio: sound }))
		await react(m, '✅')
		log.info(`Sticker con sonido enviado (${animated ? 'animado' : 'estático'}, ${sound.seconds} s de audio)`)
	}

	// ---------- !audio ----------
	async function cmdExtractAudio(m, chat, quoted) {
		const parts = getSoundStickerParts(quoted)
		if (!parts) return reply(chat, `Responde con *${config.prefix}audio* a un sticker con sonido.`)
		await react(m, '⏳')
		const buffer = await download({ node: parts.audio, dl: 'audio' })
		rememberSent(await sock.sendMessage(chat, { audio: buffer, mimetype: parts.audio.mimetype || 'audio/ogg; codecs=opus' }))
		await react(m, '✅')
	}

	// ---------- !info ----------
	async function cmdInfo(chat, rawMessage) {
		if (!rawMessage) return reply(chat, 'No hay nada que mostrar.')
		log.info({ message: rawMessage }, 'Contenido del mensaje (!info)')
		const content = normalizeMessageContent(rawMessage)
		const parts = getSoundStickerParts(content)
		let summary = `Tipo: *${getContentType(rawMessage)}*`
		if (parts) {
			summary +=
				`\n🔊 *Sticker con sonido*` +
				`\n• Audio: ${parts.audio.mimetype} · ${parts.audio.seconds ?? '?'} s · ptt=${!!parts.audio.ptt}` +
				`\n• Sticker: ${parts.sticker.mimetype} · animado=${!!parts.sticker.isAnimated}`
		}
		const json = JSON.stringify(rawMessage, hideNoise, 1)
		const body = json.length > 3000 ? json.slice(0, 3000) + '\n…(recortado, completo en la consola)' : json
		await reply(chat, `${summary}\n\n\`\`\`${body}\`\`\``)
	}

	// ---------- utilidades ----------
	async function reply(chat, text) {
		rememberSent(await sock.sendMessage(chat, { text }))
	}

	async function react(m, emoji) {
		await sock.sendMessage(m.key.remoteJid, { react: { text: emoji, key: m.key } }).catch(() => {})
	}
}

function addExif(webp) {
	return addStickerExif(webp, { packName: config.packName, author: config.author })
}

function isOwner(key) {
	if (key.fromMe) return true
	if (!config.owners.length) return false
	const owners = config.owners.map((n) => String(n).replace(/\D/g, ''))
	return [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt]
		.filter(Boolean)
		.some((jid) => owners.includes(userPart(jid)))
}

// Cada persona tiene su propio sticker a medias, aunque estén en el mismo grupo
function pendingKey(m) {
	return `${m.key.remoteJid}|${m.key.fromMe ? 'yo' : m.key.participant || m.key.remoteJid}`
}

/** "3" o "1,5" en los argumentos = segundo donde empieza el audio */
function parseStart(args) {
	const arg = args.find((a) => /^\d+([.,]\d+)?$/.test(a))
	return arg ? parseFloat(arg.replace(',', '.')) : 0
}

/** "1:1" o "cuadrado" en los argumentos = forzar recorte cuadrado; si no, lo de config.squareCrop */
const SQUARE_ARGS = new Set(['1:1', '1x1', 'cuadrado', 'cuadro'])
function parseSquare(args) {
	return args.some((a) => SQUARE_ARGS.has(a.toLowerCase())) ? 'always' : config.squareCrop
}

/** Link escrito después del comando o en el mensaje al que se responde */
function linkFrom(args, quoted) {
	return findUrl(args.join(' ')) || findUrl(getText(quoted))
}

function senderOf(key) {
	return key.participantAlt || key.participant || key.remoteJidAlt || key.remoteJid
}

function userPart(jid) {
	return String(jid).split('@')[0].split(':')[0]
}

function getText(content) {
	if (!content) return ''
	return (
		content.conversation ||
		content.extendedTextMessage?.text ||
		content.imageMessage?.caption ||
		content.videoMessage?.caption ||
		content.documentMessage?.caption ||
		''
	)
}

function getContextInfo(content) {
	if (!content) return undefined
	const type = getContentType(content)
	return type ? content[type]?.contextInfo : undefined
}

function getQuotedRaw(content) {
	return getContextInfo(content)?.quotedMessage || undefined
}

function getQuoted(content) {
	return normalizeMessageContent(getQuotedRaw(content))
}

/** Devuelve { kind, node, dl } del medio que trae el mensaje, o null. */
function findMedia(content) {
	if (!content) return null
	if (content.stickerMessage) return { kind: 'sticker', node: content.stickerMessage, dl: 'sticker' }
	if (content.imageMessage) return { kind: 'image', node: content.imageMessage, dl: 'image' }
	if (content.videoMessage) return { kind: 'video', node: content.videoMessage, dl: 'video' }
	if (content.ptvMessage) return { kind: 'video', node: content.ptvMessage, dl: 'video' }
	if (content.audioMessage) return { kind: 'audio', node: content.audioMessage, dl: 'audio' }
	const doc = content.documentMessage
	const mime = doc?.mimetype || ''
	if (mime.startsWith('image/')) return { kind: 'image', node: doc, dl: 'document' }
	if (mime.startsWith('video/')) return { kind: 'video', node: doc, dl: 'document' }
	if (mime.startsWith('audio/')) return { kind: 'audio', node: doc, dl: 'document' }
	return null
}

async function download({ node, dl }) {
	const stream = await downloadContentFromMessage(node, dl)
	const chunks = []
	for await (const chunk of stream) chunks.push(chunk)
	return Buffer.concat(chunks)
}

const NOISY_KEYS = new Set([
	'url', 'directPath', 'mediaKey', 'fileSha256', 'fileEncSha256', 'jpegThumbnail', 'pngThumbnail',
	'firstFrameSidecar', 'streamingSidecar', 'waveform', 'messageContextInfo', 'contextInfo', 'thumbnailDirectPath'
])
function hideNoise(key, value) {
	return NOISY_KEYS.has(key) ? '…' : value
}
