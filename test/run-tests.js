// Pruebas sin conexión a WhatsApp: formato del mensaje y conversiones con ffmpeg.
//   npm test
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateWAMessageFromContent, normalizeMessageContent, proto } from 'baileys'
import protobuf from 'protobufjs'
import WebP from 'node-webpmux'
import { addStickerExif } from '../src/exif.js'
import { cropFilter, detectBlackBars, imageToSticker, isAnimatedWebp, probe, probeBuffer, toStickerAudio, videoToSticker } from '../src/media.js'
import { getSoundStickerParts } from '../src/soundSticker.js'

let failed = 0
async function test(name, fn) {
	try {
		await fn()
		console.log(`✔ ${name}`)
	} catch (err) {
		failed++
		console.error(`✖ ${name}\n  ${err.stack}`)
	}
}

// Esquema de referencia con los números de campo del protobuf de WhatsApp Web
// (copiados de whatsmeow: proto/waE2E/WAWebProtobufsE2E.proto)
const REFERENCE = protobuf.parse(`
syntax = "proto2";
package ref;
message Message {
	optional StickerMessage stickerMessage = 26;
	optional FutureProofMessage audioStickerMessage = 134;
}
message FutureProofMessage { optional Message message = 1; }
message StickerMessage {
	oneof audio { AudioMessage audioMessage = 26; }
	optional string URL = 1;
	optional string mimetype = 5;
	optional bool isAnimated = 13;
}
message AudioMessage {
	optional string URL = 1;
	optional string mimetype = 2;
	optional uint32 seconds = 5;
	optional bool ptt = 6;
}`).root.lookupType('ref.Message')

const soundSticker = () => ({
	audioStickerMessage: {
		message: {
			stickerMessage: {
				url: 'https://mmg.whatsapp.net/sticker',
				mimetype: 'image/webp',
				isAnimated: true,
				audioMessage: { url: 'https://mmg.whatsapp.net/audio', mimetype: 'audio/ogg; codecs=opus', seconds: 4, ptt: false }
			}
		}
	}
})

await test('el mensaje se codifica con los campos 134 y 26 del protobuf oficial', () => {
	const bytes = proto.Message.encode(soundSticker()).finish()
	const ref = REFERENCE.toObject(REFERENCE.decode(bytes))
	const st = ref.audioStickerMessage.message.stickerMessage
	assert.equal(st.URL, 'https://mmg.whatsapp.net/sticker')
	assert.equal(st.isAnimated, true)
	assert.equal(st.audioMessage.URL, 'https://mmg.whatsapp.net/audio')
	assert.equal(st.audioMessage.mimetype, 'audio/ogg; codecs=opus')
	assert.equal(st.audioMessage.seconds, 4)
})

await test('Baileys parcheado decodifica un sticker con sonido (recibir)', () => {
	const refBytes = REFERENCE.encode(REFERENCE.fromObject({
		audioStickerMessage: { message: { stickerMessage: { URL: 'u', mimetype: 'image/webp', audioMessage: { URL: 'a', seconds: 7 } } } }
	})).finish()
	const msg = proto.Message.decode(refBytes)
	const parts = getSoundStickerParts(normalizeMessageContent(msg))
	assert.ok(parts, 'no se detectó como sticker con sonido')
	assert.equal(parts.audio.url, 'a')
	assert.equal(parts.audio.seconds, 7)
})

await test('fromObject/toObject conservan el audio (lo usa Baileys internamente)', () => {
	const obj = proto.Message.toObject(proto.Message.fromObject(soundSticker()))
	assert.equal(obj.audioStickerMessage.message.stickerMessage.audioMessage.seconds, 4)
})

await test('generateWAMessageFromContent mantiene la estructura y responde a un mensaje', () => {
	const quoted = { key: { remoteJid: '123@s.whatsapp.net', id: 'ABC', fromMe: false }, message: { conversation: 'hola' } }
	const wa = generateWAMessageFromContent('123@s.whatsapp.net', soundSticker(), { userJid: '999@s.whatsapp.net', quoted })
	const ref = REFERENCE.toObject(REFERENCE.decode(proto.Message.encode(wa.message).finish()))
	assert.equal(ref.audioStickerMessage.message.stickerMessage.audioMessage.seconds, 4)
	assert.equal(wa.message.audioStickerMessage.message.stickerMessage.contextInfo.stanzaId, 'ABC')
})

// ---------- ffmpeg ----------
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bot-stickers-test-'))
const ff = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
const fixture = (name) => readFileSync(path.join(tmp, name))
ff('-f', 'lavfi', '-i', 'testsrc2=size=800x600', '-frames:v', '1', path.join(tmp, 'img.png'))
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
	'-t', '9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(tmp, 'video.mp4'))
ff('-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '15', '-c:a', 'libmp3lame', path.join(tmp, 'audio.mp3'))
// TikTok típico: video 16:9 en un cuadro vertical 9:16 con bordes negros arriba y abajo,
// más un recuadro blanco en el borde durante 0,5 s (como un texto que aparece un momento)
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '6',
	'-vf', "pad=720:1280:40:460:black,drawbox=x=100:y=100:w=300:h=80:color=white:t=fill:enable='lt(t,0.5)'",
	'-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tmp, 'letterbox.mp4'))
// Video vertical dentro de un cuadro horizontal (bordes a los lados)
ff('-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '3',
	'-vf', 'pad=1280:720:460:40:black', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tmp, 'pillarbox.mp4'))

async function firstFrameRGBA(webp) {
	await WebP.Image.initLib()
	const img = new WebP.Image()
	await img.load(webp)
	return { width: img.width, data: img.hasAnim ? await img.getFrameData(0) : await img.getImageData() }
}
const pixel = ({ width, data }, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]

await test('imagen -> sticker estático 512x512 <= 100 KB', async () => {
	const webp = await imageToSticker(fixture('img.png'))
	assert.equal(webp.toString('ascii', 8, 12), 'WEBP')
	assert.ok(webp.length <= 100 * 1024, `pesa ${webp.length} bytes`)
	assert.equal(isAnimatedWebp(webp), false)
	const img = new WebP.Image()
	await img.load(webp)
	assert.equal(img.width, 512)
	assert.equal(img.height, 512)
})

await test('video -> sticker animado <= 500 KB', async () => {
	const webp = await videoToSticker(fixture('video.mp4'), { maxSeconds: 6 })
	assert.ok(isAnimatedWebp(webp), 'no es animado')
	assert.ok(webp.length <= 500 * 1024, `pesa ${webp.length} bytes`)
})

await test('audio mp3 de 15 s -> opus recortado a 10 s', async () => {
	const a = await toStickerAudio(fixture('audio.mp3'), { maxSeconds: 10, format: 'opus' })
	assert.equal(a.mimetype, 'audio/ogg; codecs=opus')
	assert.equal(a.buffer.toString('ascii', 0, 4), 'OggS')
	assert.equal(a.seconds, 10)
})

await test('audio desde un video, empezando en el segundo 5', async () => {
	assert.equal((await probeBuffer(fixture('video.mp4'))).hasAudio, true)
	const a = await toStickerAudio(fixture('video.mp4'), { start: 5, maxSeconds: 10 })
	assert.equal(a.seconds, 4)
})

await test('formato aac', async () => {
	const a = await toStickerAudio(fixture('audio.mp3'), { maxSeconds: 3, format: 'aac' })
	assert.equal(a.mimetype, 'audio/mp4')
	assert.equal(a.buffer.toString('ascii', 4, 8), 'ftyp')
})

await test('metadatos del paquete (exif)', async () => {
	const webp = await addStickerExif(await imageToSticker(fixture('img.png')), { packName: 'Pack', author: 'Yo' })
	const img = new WebP.Image()
	await img.load(webp)
	assert.ok(img.exif.toString('utf8').includes('"sticker-pack-name":"Pack"'))
})

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg}: ${a.toFixed(3)} vs ${b.toFixed(3)}`)

await test('detecta bordes negros arriba/abajo (e ignora el recuadro que sale 0,5 s)', async () => {
	const box = await detectBlackBars(path.join(tmp, 'letterbox.mp4'))
	assert.ok(box, 'no detectó bordes')
	near(box.y, 460 / 1280, 'y')
	near(box.h, 360 / 1280, 'alto')
	near(box.x, 40 / 720, 'x')
	near(box.w, 640 / 720, 'ancho')
})

await test('detecta bordes negros a los lados', async () => {
	const box = await detectBlackBars(path.join(tmp, 'pillarbox.mp4'))
	assert.ok(box, 'no detectó bordes')
	near(box.x, 460 / 1280, 'x')
	near(box.w, 360 / 1280, 'ancho')
})

await test('un video sin bordes no se toca', async () => {
	assert.equal(await detectBlackBars(path.join(tmp, 'video.mp4')), null)
})

await test('el recorte deja solo el contenido, en cuadrado', async () => {
	const box = await detectBlackBars(path.join(tmp, 'letterbox.mp4'))
	const out = path.join(tmp, 'cropped.png')
	ff('-ss', '2', '-i', path.join(tmp, 'letterbox.mp4'), '-vf', cropFilter(box, true).replace(/,$/, ''), '-frames:v', '1', out)
	const dims = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', out]))
	const { width, height } = dims.streams[0]
	assert.equal(width, height, 'no quedó cuadrado')
	assert.ok(Math.abs(height - 360) <= 4, `quedó de ${width}x${height}, se esperaba ~360x360`)
	assert.equal(await detectBlackBars(out), null, 'todavía tiene bordes negros')
})

await test('sticker de TikTok con bordes: 1:1 sin bordes (auto) vs completo (never)', async () => {
	const auto = await firstFrameRGBA(await videoToSticker(fixture('letterbox.mp4'), { maxSeconds: 3, squareCrop: 'auto' }))
	const never = await firstFrameRGBA(await videoToSticker(fixture('letterbox.mp4'), { maxSeconds: 3, squareCrop: 'never' }))
	// brillo promedio de la franja de arriba (30 filas, en la parte central)
	const topBrightness = (img) => {
		let sum = 0, count = 0
		for (let y = 0; y < 30; y++) {
			for (let x = 156; x < 356; x++) {
				const [r, g, b] = pixel(img, x, y)
				sum += (r + g + b) / 3
				count++
			}
		}
		return sum / count
	}
	assert.ok(topBrightness(never) < 30, `con never arriba debería verse el borde negro (${topBrightness(never).toFixed(0)})`)
	assert.ok(topBrightness(auto) > 40, `con auto arriba debería verse el video (${topBrightness(auto).toFixed(0)})`)
	assert.equal(pixel(never, 5, 256)[3], 0, 'con never los lados deberían ser transparentes')
	assert.equal(pixel(auto, 5, 256)[3], 255, 'con auto no debería sobrar nada a los lados')
	assert.ok((await probe(path.join(tmp, 'letterbox.mp4'))).hasVideo)
})

await test('forzar 1:1: imagen y video sin bordes quedan cuadrados, sin fondo transparente', async () => {
	// img.png es 800x600 y video.mp4 640x360: sin forzar, arriba queda transparente
	const imgFit = await firstFrameRGBA(await imageToSticker(fixture('img.png')))
	const imgSquare = await firstFrameRGBA(await imageToSticker(fixture('img.png'), { square: true }))
	assert.equal(pixel(imgFit, 256, 5)[3], 0, 'sin forzar, la imagen debería tener fondo transparente arriba')
	assert.equal(pixel(imgSquare, 256, 5)[3], 255, 'con 1:1 la imagen debería llenar el cuadro')
	assert.equal(pixel(imgSquare, 5, 256)[3], 255, 'con 1:1 la imagen debería llenar los lados')

	const vidAuto = await firstFrameRGBA(await videoToSticker(fixture('video.mp4'), { maxSeconds: 2, squareCrop: 'auto' }))
	const vidAlways = await firstFrameRGBA(await videoToSticker(fixture('video.mp4'), { maxSeconds: 2, squareCrop: 'always' }))
	assert.equal(pixel(vidAuto, 256, 5)[3], 0, 'en auto un video sin bordes no se recorta')
	assert.equal(pixel(vidAlways, 256, 5)[3], 255, 'con 1:1 el video debería llenar el cuadro')
})

rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} prueba(s) fallaron` : '\nTodo OK')
process.exit(failed ? 1 : 0)
