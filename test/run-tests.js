// Pruebas sin conexión a WhatsApp: formato del mensaje y conversiones con ffmpeg.
//   npm test
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateWAMessageFromContent, normalizeMessageContent, proto } from 'baileys'
import protobuf from 'protobufjs'
import WebP from 'node-webpmux'
import { addStickerExif } from '../src/exif.js'
import {
	AUDIO_EFFECTS, cropFilter, detectBlackBars, imageToSticker, isAnimatedWebp, probe, probeBuffer,
	toMp3, toShareableVideo, toStickerAudio, videoToSticker
} from '../src/media.js'
import { inputSeconds, parseOptions } from '../src/options.js'
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

// ---------- opciones (!ss 3-8 ardilla redondo...) ----------
await test('opciones: inicio, rango, 1:1, redondo y efectos', () => {
	let o = parseOptions(['3'])
	assert.equal(o.start, 3)
	assert.equal(o.duration, null)
	o = parseOptions(['3-8', 'Ardilla', 'REDONDO', 'https://www.tiktok.com/@a/video/1'])
	assert.deepEqual([o.start, o.duration, o.circle, o.square], [3, 5, true, false])
	assert.deepEqual(o.effects, ['ardilla'])
	o = parseOptions(['1:05-1:10,5'])
	assert.equal(o.start, 65)
	assert.equal(o.duration, 5.5)
	o = parseOptions(['1:1']) // es el recorte cuadrado, no un tiempo
	assert.deepEqual([o.square, o.start], [true, 0])
	o = parseOptions(['bass', 'rápido', 'reversa', 'eco'])
	assert.deepEqual(o.effects, ['reversa', 'rapido', 'eco', 'bass'])
	assert.equal(o.speed, 1.5)
	assert.equal(o.reverse, true)
	assert.throws(() => parseOptions(['8-3']), /mayor que el inicio/)
	assert.throws(() => parseOptions(['rapido', 'lento']), /rápido y lento/)
	// cuánto se lee del original
	assert.equal(inputSeconds(parseOptions([]), 6), 6)
	assert.equal(inputSeconds(parseOptions(['rapido']), 6), 9) // 9 s acelerados = 6 s
	assert.equal(inputSeconds(parseOptions(['3-5']), 6), 2)
	assert.equal(inputSeconds(parseOptions(['0-30']), 10), 10)
})

// ---------- redondo ----------
await test('redondo: imagen, video y sticker estático quedan en círculo', async () => {
	const alpha = (img, x, y) => pixel(img, x, y)[3]
	const check = (img, what) => {
		assert.equal(alpha(img, 3, 3), 0, `${what}: la esquina debería ser transparente`)
		assert.equal(alpha(img, 508, 508), 0, `${what}: la esquina debería ser transparente`)
		assert.equal(alpha(img, 256, 256), 255, `${what}: el centro debería verse`)
		assert.equal(alpha(img, 6, 256), 255, `${what}: el borde del círculo debería verse`)
	}
	const img = await imageToSticker(fixture('img.png'), { circle: true })
	check(await firstFrameRGBA(img), 'imagen')
	check(await firstFrameRGBA(await videoToSticker(fixture('letterbox.mp4'), { maxSeconds: 2, circle: true })), 'video')
	// un sticker estático (con exif) se puede volver a recortar
	const sticker = await addStickerExif(await imageToSticker(fixture('img.png')), { packName: 'P', author: 'A' })
	check(await firstFrameRGBA(await imageToSticker(sticker, { circle: true })), 'sticker')
})

// ---------- efectos de sonido ----------
ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libmp3lame', path.join(tmp, 'la440.mp3'))

/** Frecuencia aproximada contando cruces por cero */
function frequency(audioBuffer) {
	const file = path.join(tmp, 'freq-in')
	writeFileSync(file, audioBuffer)
	const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 64 * 1024 * 1024 })
	const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
	// se ignoran los bordes (el códec mete un poco de silencio)
	const from = 4800
	const to = samples.length - 4800
	let crossings = 0
	for (let i = from + 1; i < to; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++
	return crossings / 2 / ((to - from) / 48000)
}

await test('efectos: grave y ardilla cambian el tono sin cambiar la duración', async () => {
	const normal = await toStickerAudio(fixture('la440.mp3'), { maxSeconds: 4 })
	const grave = await toStickerAudio(fixture('la440.mp3'), { maxSeconds: 4, effects: ['grave'] })
	const ardilla = await toStickerAudio(fixture('la440.mp3'), { maxSeconds: 4, effects: ['ardilla'] })
	const f0 = frequency(normal.buffer)
	assert.ok(Math.abs(f0 - 440) < 15, `normal: ${f0.toFixed(0)} Hz`)
	assert.ok(Math.abs(frequency(grave.buffer) - 330) < 20, `grave: ${frequency(grave.buffer).toFixed(0)} Hz (se esperaba ~330)`)
	assert.ok(Math.abs(frequency(ardilla.buffer) - 660) < 25, `ardilla: ${frequency(ardilla.buffer).toFixed(0)} Hz (se esperaba ~660)`)
	assert.equal(grave.seconds, 4)
	assert.equal(ardilla.seconds, 4)
})

await test('efectos: rápido acorta, lento alarga y todos funcionan juntos', async () => {
	const rapido = await toStickerAudio(fixture('audio.mp3'), { maxSeconds: 9, effects: ['rapido'] })
	assert.equal(rapido.seconds, 6)
	const lento = await toStickerAudio(fixture('audio.mp3'), { maxSeconds: 3, effects: ['lento'] })
	assert.equal(lento.seconds, 4)
	for (const name of Object.keys(AUDIO_EFFECTS)) {
		const a = await toStickerAudio(fixture('video.mp4'), { maxSeconds: 3, effects: [name] })
		assert.equal(a.buffer.toString('ascii', 0, 4), 'OggS', name)
	}
	// 6 s acelerados = 4 s (+ medio segundo de cola del eco)
	const all = await toStickerAudio(fixture('video.mp4'), { maxSeconds: 6, effects: ['reversa', 'rapido', 'ardilla', 'eco', 'bass'] })
	assert.ok(all.seconds === 4 || all.seconds === 5, `duró ${all.seconds} s`)
	// con tope, la cola del eco no se pasa del límite
	const capped = await toStickerAudio(fixture('audio.mp3'), { maxSeconds: 10, maxOutputSeconds: 10, effects: ['eco'] })
	assert.equal(capped.seconds, 10)
	assert.ok((await probeBuffer(capped.buffer)).duration <= 10.05)
})

await test('video: rápido acorta la animación, reversa la invierte', async () => {
	const totalMs = async (webp) => {
		const img = new WebP.Image()
		await img.load(webp)
		return img.frames.reduce((s, f) => s + f.delay, 0)
	}
	const normal = await videoToSticker(fixture('video.mp4'), { maxSeconds: 3 })
	const rapido = await videoToSticker(fixture('video.mp4'), { maxSeconds: 3, speed: 1.5 })
	assert.ok(Math.abs((await totalMs(normal)) - 3000) < 150, `normal dura ${await totalMs(normal)} ms`)
	assert.ok(Math.abs((await totalMs(rapido)) - 2000) < 150, `rápido dura ${await totalMs(rapido)} ms`)
	// al revés: el primer cuadro se parece al último del normal
	const reversed = await videoToSticker(fixture('video.mp4'), { maxSeconds: 3, reverse: true })
	const img = new WebP.Image()
	await img.load(normal)
	const lastNormal = { width: 512, data: await img.getFrameData(img.frames.length - 1) }
	const firstNormal = { width: 512, data: await img.getFrameData(0) }
	const firstReversed = await firstFrameRGBA(reversed)
	const diff = (a, b) => {
		let sum = 0
		for (let i = 0; i < a.data.length; i += 4 * 97) sum += Math.abs(a.data[i] - b.data[i])
		return sum
	}
	assert.ok(diff(firstReversed, lastNormal) < diff(firstReversed, firstNormal), 'el video al revés no empieza por el final')
})

// ---------- !expropiar ----------
await test('expropiar: cambia paquete y autor de un sticker que ya tenía', async () => {
	const animated = await addStickerExif(await videoToSticker(fixture('video.mp4'), { maxSeconds: 2 }), { packName: 'Ajeno', author: 'Otro' })
	const mine = await addStickerExif(animated, { packName: 'Mío', author: 'HypeR' })
	const img = new WebP.Image()
	await img.load(mine)
	const exif = img.exif.toString('utf8')
	assert.ok(exif.includes('"sticker-pack-name":"Mío"') && exif.includes('"sticker-pack-publisher":"HypeR"'), exif)
	assert.ok(!exif.includes('Ajeno'))
	assert.ok(isAnimatedWebp(mine), 'dejó de ser animado')
})

// ---------- !video / !mp3 ----------
ff('-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330',
	'-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-c:a', 'libopus', '-shortest', path.join(tmp, 'clip.webm'))

await test('video: un mp4 H.264 se manda tal cual; un webm se convierte a mp4 H.264', async () => {
	const mp4 = fixture('video.mp4')
	assert.equal(await toShareableVideo(mp4), mp4)
	const converted = await toShareableVideo(fixture('clip.webm'))
	const info = await probeBuffer(converted)
	assert.equal(info.videoCodec, 'h264')
	assert.equal(info.audioCodec, 'aac')
	assert.ok(info.format.includes('mp4'))
})

await test('mp3: audio de un video', async () => {
	const mp3 = await toMp3(fixture('clip.webm'))
	const info = await probeBuffer(mp3.buffer)
	assert.equal(info.audioCodec, 'mp3')
	assert.equal(info.hasVideo, false)
	assert.equal(mp3.seconds, 3)
})

rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} prueba(s) fallaron` : '\nTodo OK')
process.exit(failed ? 1 : 0)
