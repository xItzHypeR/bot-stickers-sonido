// Metadatos (exif) del webp: lo que WhatsApp muestra como nombre/autor del paquete.
import { randomUUID } from 'node:crypto'
import WebP from 'node-webpmux'

const EXIF_HEADER = Buffer.from([
	0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
	0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
])

function buildExif(data) {
	const json = Buffer.from(JSON.stringify(data), 'utf8')
	const exif = Buffer.concat([EXIF_HEADER, json])
	exif.writeUIntLE(json.length, 14, 4)
	return exif
}

/** El JSON que va dentro del exif de un sticker, o {} si no tiene o no se entiende. */
function readExifJson(exif) {
	if (!exif) return {}
	const text = Buffer.from(exif).toString('utf8')
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start < 0 || end < start) return {}
	try {
		const data = JSON.parse(text.slice(start, end + 1))
		return data && typeof data === 'object' ? data : {}
	} catch {
		return {}
	}
}

async function editExif(webpBuffer, change) {
	const img = new WebP.Image()
	await img.load(webpBuffer)
	img.exif = change(img.exif)
	return img.save(null)
}

export function addStickerExif(webpBuffer, { packName, author, emojis = [] }) {
	return editExif(webpBuffer, () => buildExif({
		'sticker-pack-id': 'bot-stickers-sonido',
		'sticker-pack-name': packName,
		'sticker-pack-publisher': author,
		emojis
	}))
}

/** Copia los metadatos (paquete, autor...) de un webp a otro. */
export async function copyExif(fromWebp, toWebp) {
	const src = new WebP.Image()
	await src.load(fromWebp)
	if (!src.exif) return toWebp
	return editExif(toWebp, () => src.exif)
}

/**
 * Le pone al webp un id nuevo en los metadatos, conservando paquete y autor, para que cada
 * sticker con sonido sea un archivo distinto. WhatsApp en iPhone reconoce los stickers por su
 * archivo: si ya tenía uno idéntico (el mismo sticker con otro sonido), reproduce el sonido viejo.
 */
export function withUniqueId(webpBuffer) {
	return editExif(webpBuffer, (exif) => buildExif({ ...readExifJson(exif), 'bot-sticker-id': randomUUID() }))
}
