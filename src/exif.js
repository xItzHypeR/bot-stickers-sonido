// Agrega al webp los metadatos que WhatsApp muestra como nombre/autor del paquete.
import WebP from 'node-webpmux'

const EXIF_HEADER = Buffer.from([
	0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
	0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
])

export async function addStickerExif(webpBuffer, { packName, author, emojis = [] }) {
	const json = Buffer.from(JSON.stringify({
		'sticker-pack-id': 'bot-stickers-sonido',
		'sticker-pack-name': packName,
		'sticker-pack-publisher': author,
		emojis
	}), 'utf8')
	const exif = Buffer.concat([EXIF_HEADER, json])
	exif.writeUIntLE(json.length, 14, 4)

	const img = new WebP.Image()
	await img.load(webpBuffer)
	img.exif = exif
	return img.save(null)
}
