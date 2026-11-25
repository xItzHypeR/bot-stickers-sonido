// Lógica de comandos del bot.
import { downloadContentFromMessage, getContentType, normalizeMessageContent } from 'baileys'
import config from './config.js'
import { downloadFromLink, findUrl } from './download.js'
import { addStickerExif } from './exif.js'
import {
	imageToSticker, isAnimatedWebp, probeBuffer, toMp3, toShareableVideo, toStickerAudio, videoToSticker
} from './media.js'
import { inputSeconds, parseOptions, plain } from './options.js'
import { getSoundStickerParts, sendSoundSticker } from './soundSticker.js'

const MAX_MESSAGE_AGE_S = 120
const VISUAL_KINDS = new Set(['image', 'video', 'sticker'])

// Stickers con sonido a medias, por chat y persona: { visual?, audio?, ...opciones, expires }
const pending = new Map()

const p = config.prefix
const MENU = `*🤖 Bot de stickers*

*${p}s* — sticker normal
  Responde a una imagen, video, GIF o *link* con ${p}s (o mándalo con ${p}s de texto).

*${p}ss* — sticker con sonido 🔊
  • Responde a un *video* con ${p}ss → sticker animado con el audio del video.
  • Responde a un *link* con ${p}ss, o escribe ${p}ss <link>.
  • Responde a una *imagen o sticker* con ${p}ss y luego manda el *audio, nota de voz o link*.
  • O al revés: responde a un *audio* con ${p}ss y luego manda la imagen.
  • Responde a un *sticker con sonido* con ${p}ss y efectos (ej. ${p}ss ardilla eco) → le aplica los efectos a su propio sonido.
  Máximo ${config.maxAudioSeconds} s de audio.

*Opciones* para ${p}s y ${p}ss (en cualquier orden):
  • *3* → empieza en el segundo 3
  • *3-8* → del segundo 3 al 8 (también *1:05-1:10*)
  • *1:1* → recorte cuadrado · *redondo* → en círculo
  • Efectos: *grave*, *ardilla*, *eco*, *reversa*, *rapido*, *lento*, *bass*
    (rapido, lento y reversa también mueven el video)
  Ej.: ${p}ss 3-8 ardilla redondo <link>

*${p}expropiar Paquete|Autor* — responde a un sticker para ponerle tu nombre de paquete y autor
*${p}video <link>* — descarga el video (TikTok, Instagram, X, YouTube…)
*${p}mp3 <link>* — descarga solo el audio
*${p}audio* — responde a un sticker con sonido para sacar su audio
*${p}info* — responde a un mensaje para ver cómo viene por dentro
*${p}cancelar* — cancela un sticker con sonido a medias`

export function createBot(sock, { log, rememberSent, isSentByBot, getSent = () => undefined }) {
	// Stickers vistos, por id de mensaje. Al responder a un sticker, WhatsApp manda una copia
	// sin el audio; con esto se recupera el sticker con sonido completo.
	const stickers = new Map()
	function rememberSticker(m) {
		const content = normalizeMessageContent(m.message)
		if (!content?.stickerMessage || !m.key?.id) return
		stickers.set(m.key.id, content)
		if (stickers.size > 300) stickers.delete(stickers.keys().next().value)
	}

	/** El mensaje al que se responde; si es un sticker, el original completo (con su audio) si se conoce. */
	function resolveQuoted(content) {
		const quoted = getQuoted(content)
		if (!quoted?.stickerMessage) return quoted
		const id = getContextInfo(content)?.stanzaId
		const original = id && (stickers.get(id) || normalizeMessageContent(getSent(id)))
		if (original?.stickerMessage) return original
		// No se vio el original (por ejemplo, llegó antes de prender el bot): puede que le falte el audio
		unverified.add(quoted)
		return quoted
	}
	const unverified = new WeakSet()
	const SOUND_HINT = 'Si ese sticker tenía sonido, *reenvíalo a este chat* y vuelve a responderle: ' +
		'al responder, WhatsApp no le pasa el audio al bot si el sticker llegó antes de prenderlo.'

	sock.ev.on('messages.upsert', ({ messages, type }) => {
		for (const m of messages) rememberSticker(m)
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

		const body = text.slice(config.prefix.length).trim()
		const [rawCmd, ...args] = body.split(/\s+/)
		const rest = body.slice((rawCmd || '').length).trim() // todo lo que va después del comando
		const cmd = plain(rawCmd || '')
		const quoted = resolveQuoted(content)

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
				case 'expropiar':
					return await cmdExpropriate(m, chat, quoted, rest)
				case 'video':
				case 'descargar':
				case 'mp4':
					return await cmdDownload(m, chat, quoted, args, 'video')
				case 'mp3':
				case 'musica':
				case 'cancion':
					return await cmdDownload(m, chat, quoted, args, 'mp3')
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
		const opts = parseOptions(args)
		await react(m, '⏳')
		let buffer
		if (url) {
			const dl = await downloadFromLink(url)
			if (!dl.hasVideo) throw new Error('Ese link no trae video.')
			media = { kind: 'video' }
			buffer = dl.buffer
		} else {
			buffer = await download(media)
		}
		const { webp, animated } = await makeWebp({ kind: media.kind, buffer }, opts)
		rememberSent(await sock.sendMessage(chat, { sticker: webp, isAnimated: animated }))
		await react(m, '✅')
	}

	/** Imagen, video o sticker -> webp del sticker, con las opciones (rango, 1:1, redondo, velocidad...). */
	async function makeWebp({ kind, buffer }, opts) {
		if (kind === 'sticker') {
			const animated = isAnimatedWebp(buffer)
			// Un sticker estático se puede volver a recortar; uno animado se usa tal cual
			if (!animated && (opts.square || opts.circle)) {
				return { webp: await addExif(await imageToSticker(buffer, opts)), animated: false }
			}
			return { webp: buffer, animated }
		}
		if (kind === 'image') {
			return { webp: await addExif(await imageToSticker(buffer, opts)), animated: false }
		}
		const webp = await videoToSticker(buffer, {
			start: opts.start,
			maxSeconds: inputSeconds(opts, config.maxVideoSeconds),
			squareCrop: opts.square ? 'always' : config.squareCrop,
			circle: opts.circle,
			speed: opts.speed,
			reverse: opts.reverse
		})
		return { webp: await addExif(webp), animated: true }
	}

	// ---------- !ss ----------
	async function cmdSoundSticker(m, chat, key, content, quoted, args) {
		const sources = [findMedia(content), findMedia(quoted)].filter(Boolean)
		const job = { ...parseOptions(args), expires: Date.now() + config.pendingTimeoutMs }

		const visualSrc = sources.find((s) => VISUAL_KINDS.has(s.kind))
		const audioSrc = sources.find((s) => s.kind === 'audio')
		const url = visualSrc ? null : linkFrom(args, quoted)

		if (!visualSrc && !audioSrc && !url) {
			return reply(chat,
				`Responde con *${config.prefix}ss* a un video, imagen, sticker, audio o link de TikTok.\n` +
				`Escribe *${config.prefix}menu* para ver cómo funciona.`)
		}

		// Sticker que ya tiene sonido: con opciones (efectos, rango, redondo...) se rehace con su propio
		// sonido; sin opciones se pide un audio nuevo, para poder cambiárselo.
		const ownParts = visualSrc?.kind === 'sticker' ? getSoundStickerParts(quoted) : null
		const reuseOwnSound = ownParts && visualSrc.node === ownParts.sticker && !audioSrc && hasOptions(job)

		await react(m, '⏳')
		if (visualSrc) job.visual = { kind: visualSrc.kind, buffer: await download(visualSrc) }
		if (audioSrc) job.audio = { buffer: await download(audioSrc) }
		if (reuseOwnSound) job.audio = { buffer: await download({ node: ownParts.audio, dl: 'audio' }) }
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
			let msg = `🖼️ Listo. Ahora manda el *audio, nota de voz o link* (máx. ${config.maxAudioSeconds} s).\n${config.prefix}cancelar para cancelar.`
			if (ownParts) {
				msg += `\n\nℹ️ Ese sticker ya tiene sonido: si solo quieres ponerle efectos, ${p}cancelar y respóndele con *${p}ss ardilla* (o el efecto que quieras).`
			} else if (unverified.has(quoted) && hasOptions(job)) {
				msg += `\n\nℹ️ ${SOUND_HINT}`
			}
			await reply(chat, msg)
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

	async function buildAndSend(m, chat, job) {
		const { visual, audio } = job
		await react(m, '⏳')
		const { webp, animated } = await makeWebp(visual, job)

		// Si el audio sale del mismo video, que dure lo mismo que la animación
		const maxOutput = audio.fromVideo ? Math.min(config.maxVideoSeconds, config.maxAudioSeconds) : config.maxAudioSeconds
		const sound = await toStickerAudio(audio.buffer, {
			start: job.start,
			maxSeconds: inputSeconds(job, maxOutput),
			maxOutputSeconds: maxOutput,
			format: config.audioFormat,
			effects: job.effects
		})

		rememberSent(await sendSoundSticker(sock, chat, { webp, animated, audio: sound }))
		await react(m, '✅')
		const extras = [job.circle && 'redondo', job.square && '1:1', ...job.effects].filter(Boolean)
		log.info(`Sticker con sonido enviado (${animated ? 'animado' : 'estático'}, ${sound.seconds} s de audio` +
			`${extras.length ? `, ${extras.join(' ')}` : ''})`)
	}

	// ---------- !expropiar ----------
	async function cmdExpropriate(m, chat, quoted, rest) {
		const media = findMedia(quoted)
		if (media?.kind !== 'sticker') {
			return reply(chat, `Responde a un sticker con *${p}expropiar Paquete|Autor*.`)
		}
		const [pack, author] = rest.split('|').map((s) => s.trim().slice(0, 60))
		const meta = { packName: pack || config.packName, author: author || config.author }
		await react(m, '⏳')
		const original = await download(media)
		let webp
		try {
			webp = await addStickerExif(original, meta)
		} catch {
			throw new Error('Ese sticker no se puede editar (no es un webp normal).')
		}
		const animated = isAnimatedWebp(original)
		const parts = getSoundStickerParts(quoted)
		if (parts) {
			// Sticker con sonido: se reenvía con el mismo audio
			const audio = {
				buffer: await download({ node: parts.audio, dl: 'audio' }),
				seconds: parts.audio.seconds || 1,
				mimetype: parts.audio.mimetype || 'audio/ogg; codecs=opus'
			}
			rememberSent(await sendSoundSticker(sock, chat, { webp, animated, audio }))
		} else {
			rememberSent(await sock.sendMessage(chat, { sticker: webp, isAnimated: animated }))
			if (unverified.has(quoted)) await reply(chat, `ℹ️ Salió sin sonido. ${SOUND_HINT}`)
		}
		await react(m, '✅')
		log.info(`Sticker expropiado (${parts ? 'con sonido' : 'sin sonido'}): ${meta.packName} / ${meta.author}`)
	}

	// ---------- !video / !mp3 ----------
	async function cmdDownload(m, chat, quoted, args, kind) {
		const url = linkFrom(args, quoted)
		if (!url) return reply(chat, `Escribe *${p}${kind} <link>* o responde a un link con *${p}${kind}*.`)
		await react(m, '⏳')
		if (kind === 'video') {
			const dl = await downloadFromLink(url)
			if (!dl.hasVideo) throw new Error(`Ese link no trae video. Prueba con ${p}mp3.`)
			rememberSent(await sock.sendMessage(chat, { video: await toShareableVideo(dl.buffer), mimetype: 'video/mp4' }))
		} else {
			const dl = await downloadFromLink(url, { audioOnly: true })
			if (!dl.hasAudio) throw new Error('Ese link no trae audio.')
			const mp3 = await toMp3(dl.buffer)
			rememberSent(await sock.sendMessage(chat, { audio: mp3.buffer, mimetype: 'audio/mpeg', seconds: mp3.seconds }))
		}
		await react(m, '✅')
	}

	// ---------- !audio ----------
	async function cmdExtractAudio(m, chat, quoted) {
		const parts = getSoundStickerParts(quoted)
		if (!parts) {
			if (unverified.has(quoted)) return reply(chat, `No veo sonido en ese sticker. ${SOUND_HINT}`)
			return reply(chat, `Responde con *${config.prefix}audio* a un sticker con sonido.`)
		}
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

/** ¿Se escribió alguna opción (efectos, rango, inicio, 1:1, redondo)? */
function hasOptions(opts) {
	return opts.effects.length > 0 || opts.duration !== null || opts.start > 0 || opts.square || opts.circle
}

// Cada persona tiene su propio sticker a medias, aunque estén en el mismo grupo
function pendingKey(m) {
	return `${m.key.remoteJid}|${m.key.fromMe ? 'yo' : m.key.participant || m.key.remoteJid}`
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
