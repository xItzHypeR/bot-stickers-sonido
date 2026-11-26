// Envío de stickers con sonido.
//
// Formato (tomado del protobuf de WhatsApp Web):
//   Message.audioStickerMessage (campo 134) = FutureProofMessage {
//     message: Message {
//       stickerMessage: StickerMessage {
//         ...datos normales del sticker webp...,
//         audioMessage (campo 26) = AudioMessage { ...audio subido aparte... }
//       }
//     }
//   }
// Baileys todavía no conoce esos campos; los agrega el parche de
// patches/baileys+7.0.0-rc14.patch (se aplica solo con `npm install`).
import { generateWAMessageFromContent, prepareWAMessageMedia } from 'baileys'
import { withUniqueId } from './exif.js'

/**
 * @param {import('baileys').WASocket} sock
 * @param {string} jid chat destino
 * @param {{ webp: Buffer, animated: boolean, audio: { buffer: Buffer, seconds: number, mimetype: string }, quoted?: any }} data
 */
export async function sendSoundSticker(sock, jid, { webp, animated, audio, quoted }) {
	const opts = { upload: sock.waUploadToServer }
	// Archivo único: si no, el iPhone puede tocar el sonido de otro sticker con la misma imagen
	const sticker = await withUniqueId(webp)

	// Se suben por separado: el webp como sticker y el sonido como audio
	const [{ stickerMessage }, { audioMessage }] = await Promise.all([
		prepareWAMessageMedia({ sticker, mimetype: 'image/webp', isAnimated: animated }, opts),
		prepareWAMessageMedia({ audio: audio.buffer, mimetype: audio.mimetype, seconds: audio.seconds, ptt: false }, opts)
	])

	stickerMessage.audioMessage = audioMessage

	const msg = generateWAMessageFromContent(
		jid,
		{ audioStickerMessage: { message: { stickerMessage } } },
		{ userJid: sock.user.id, quoted }
	)
	await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
	return msg
}

/** Saca el sticker y el audio de un mensaje (ya normalizado) si es sticker con sonido. */
export function getSoundStickerParts(content) {
	const sticker = content?.stickerMessage
	if (!sticker?.audioMessage) return null
	return { sticker, audio: sticker.audioMessage }
}
