// Conversión de imágenes, videos y audios con ffmpeg.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

const STATIC_MAX_BYTES = 100 * 1024 // límite de WhatsApp para stickers estáticos
const ANIMATED_MAX_BYTES = 500 * 1024 // límite de WhatsApp para stickers animados

export const AUDIO_FORMATS = {
	opus: { mimetype: 'audio/ogg; codecs=opus', ext: 'ogg', args: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'] },
	aac: { mimetype: 'audio/mp4', ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4'] }
}

function run(bin, args, { wantStderr = false } = {}) {
	return new Promise((resolve, reject) => {
		execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				if (err.code === 'ENOENT') {
					return reject(new Error(`No se encontró "${bin}". Instala ffmpeg y agrégalo al PATH.`))
				}
				const tail = String(stderr).trim().split('\n').slice(-4).join('\n')
				return reject(new Error(`${path.basename(bin)} falló: ${tail}`))
			}
			resolve(wantStderr ? String(stderr) : stdout)
		})
	})
}

export async function withTempDir(fn) {
	const dir = path.join(os.tmpdir(), `bot-stickers-${randomBytes(6).toString('hex')}`)
	await fs.mkdir(dir, { recursive: true })
	try {
		return await fn(dir)
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}

/** Duración (s) y si el archivo trae video/audio. */
export async function probe(file) {
	const out = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file])
	const json = JSON.parse(out)
	const types = (json.streams || []).map((s) => s.codec_type)
	return {
		duration: Number(json.format?.duration) || 0,
		hasAudio: types.includes('audio'),
		hasVideo: types.includes('video')
	}
}

export async function probeBuffer(buffer) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		await fs.writeFile(input, buffer)
		return probe(input)
	})
}

// Ajusta a 512x512 sin deformar, con fondo transparente
const FIT_512 =
	'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,' +
	'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'

/**
 * Imagen (jpg/png/webp estático...) -> sticker webp estático 512x512.
 * square: true -> recorta un cuadrado al centro en vez de dejar fondo transparente.
 */
export async function imageToSticker(buffer, { square = false } = {}) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		await fs.writeFile(input, buffer)
		const crop = square ? cropFilter(null, true) : ''
		let best
		for (const quality of [80, 65, 50, 35, 20]) {
			const output = path.join(dir, `out-${quality}.webp`)
			await run(FFMPEG, [
				'-y', '-i', input, '-vf', `${crop}${FIT_512}`, '-frames:v', '1',
				'-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '6', output
			])
			best = await fs.readFile(output)
			if (best.length <= STATIC_MAX_BYTES) break
		}
		return best
	})
}

/**
 * Busca bordes negros (arriba/abajo o a los lados) en el tramo del video que se va a usar.
 * Devuelve el área con contenido como fracciones del cuadro { x, y, w, h } (de 0 a 1),
 * o null si no hay bordes que valga la pena quitar.
 */
export async function detectBlackBars(file, { start = 0, seconds = 6 } = {}) {
	const A = 480 // se analiza a 480x480 y luego se escala a la medida real
	const log = await run(FFMPEG, [
		'-hide_banner', '-nostats', '-ss', String(start), '-t', String(seconds), '-i', file,
		// reset=1: una medición por cuadro, para ignorar destellos o textos que aparecen un momento
		'-vf', `fps=5,scale=${A}:${A},cropdetect=limit=24:round=2:reset=1:skip=0`,
		'-an', '-f', 'null', '-'
	], { wantStderr: true })

	const frames = [...log.matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+)/g)]
		.map((m) => m.slice(1).map(Number))
		.filter(([x1, x2, y1, y2]) => x2 > x1 && y2 > y1) // cuadros totalmente negros no cuentan
	if (!frames.length) return null

	// Contenido que se ve en al menos el 20 % de los cuadros
	const pct = (values, p) => values.sort((a, b) => a - b)[Math.floor(p * (values.length - 1))]
	const x1 = pct(frames.map((f) => f[0]), 0.2)
	const x2 = pct(frames.map((f) => f[1]), 0.8)
	const y1 = pct(frames.map((f) => f[2]), 0.2)
	const y2 = pct(frames.map((f) => f[3]), 0.8)
	const box = { x: x1 / A, y: y1 / A, w: (x2 - x1 + 1) / A, h: (y2 - y1 + 1) / A }

	if (box.w < 0.25 || box.h < 0.2) return null // casi todo oscuro: mejor no tocarlo
	if (box.w > 0.94 && box.h > 0.94) return null // no tiene bordes (o son mínimos)
	return box
}

/** Filtros de ffmpeg para quitar los bordes (box) y/o recortar al centro en cuadrado. */
export function cropFilter(box, square) {
	const even = (expr) => `trunc(${expr}/2)*2`
	const n = (v) => v.toFixed(4)
	let f = ''
	if (box) {
		f += `crop=w='${even(`iw*${n(box.w)}`)}':h='${even(`ih*${n(box.h)}`)}'` +
			`:x='${even(`iw*${n(box.x)}`)}':y='${even(`ih*${n(box.y)}`)}',`
	}
	if (square) f += `crop=w='${even('min(iw,ih)')}':h='${even('min(iw,ih)')}',`
	return f
}

/**
 * Video/GIF -> sticker webp animado 512x512 (sin audio).
 * squareCrop: 'auto'   -> si tiene bordes negros, los quita y recorta a 1:1
 *             'always' -> siempre recorta a 1:1 (y quita bordes si hay)
 *             'never'  -> deja el video completo con fondo transparente
 */
export async function videoToSticker(buffer, { start = 0, maxSeconds = 6, squareCrop = 'auto' } = {}) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		await fs.writeFile(input, buffer)
		let crop = ''
		if (squareCrop !== 'never') {
			const box = await detectBlackBars(input, { start, seconds: maxSeconds }).catch(() => null)
			if (box || squareCrop === 'always') crop = cropFilter(box, true)
		}
		let best
		const attempts = [
			{ fps: 15, quality: 60 },
			{ fps: 12, quality: 45 },
			{ fps: 10, quality: 35 },
			{ fps: 8, quality: 25 },
			{ fps: 8, quality: 15, seconds: Math.min(maxSeconds, 4) }
		]
		for (const [i, a] of attempts.entries()) {
			const output = path.join(dir, `out-${i}.webp`)
			await run(FFMPEG, [
				'-y', '-ss', String(start), '-t', String(a.seconds ?? maxSeconds), '-i', input,
				'-vf', `fps=${a.fps},${crop}${FIT_512}`, '-an',
				'-c:v', 'libwebp', '-quality', String(a.quality), '-compression_level', '4',
				'-loop', '0', output
			])
			best = await fs.readFile(output)
			if (best.length <= ANIMATED_MAX_BYTES) break
		}
		return best
	})
}

/**
 * Cualquier audio o video -> audio para el sticker con sonido.
 * Devuelve { buffer, seconds, mimetype }.
 */
export async function toStickerAudio(buffer, { start = 0, maxSeconds = 10, format = 'opus' } = {}) {
	const fmt = AUDIO_FORMATS[format]
	if (!fmt) throw new Error(`audioFormat desconocido: ${format} (usa "opus" o "aac")`)
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		const output = path.join(dir, `audio.${fmt.ext}`)
		await fs.writeFile(input, buffer)
		const info = await probe(input)
		if (!info.hasAudio) throw new Error('Ese archivo no tiene audio.')
		await run(FFMPEG, [
			'-y', '-ss', String(start), '-t', String(maxSeconds), '-i', input,
			'-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', ...fmt.args, output
		])
		const { duration } = await probe(output)
		if (duration < 0.2) throw new Error('El audio quedó vacío (¿el inicio es mayor que la duración?).')
		return { buffer: await fs.readFile(output), seconds: Math.max(1, Math.round(duration)), mimetype: fmt.mimetype }
	})
}

/** ¿El webp es animado? (bandera de animación en el chunk VP8X) */
export function isAnimatedWebp(buffer) {
	return buffer.length > 21 && buffer.toString('ascii', 12, 16) === 'VP8X' && (buffer[20] & 0x02) !== 0
}
