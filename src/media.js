// Conversión de imágenes, videos y audios con ffmpeg.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

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

/** Duración (s), si el archivo trae video/audio y con qué códecs. */
export async function probe(file) {
	const out = await run(FFPROBE, [
		'-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json', file
	])
	const json = JSON.parse(out)
	const streams = json.streams || []
	const video = streams.find((s) => s.codec_type === 'video')
	const audio = streams.find((s) => s.codec_type === 'audio')
	return {
		duration: Number(json.format?.duration) || 0,
		format: json.format?.format_name || '',
		hasAudio: !!audio,
		hasVideo: !!video,
		audioCodec: audio?.codec_name,
		videoCodec: video?.codec_name
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

// Máscara redonda de 512x512 (un solo cuadro; alphamerge la repite en todo el video).
// El borde se suaviza 1 px para que no se vea serruchado.
const CIRCLE_MASK =
	"color=black:s=512x512:r=1:d=1,format=gray,geq=lum='255*clip(256.5-hypot(X-255.5,Y-255.5),0,1)'"

/**
 * Arma los filtros del sticker. `chain` son los filtros previos (terminan en coma);
 * `circle` exige que chain ya deje el cuadro cuadrado. `tail` va al final (p. ej. reverse).
 */
function stickerFilter(chain, { circle = false, tail = '' } = {}) {
	const end = tail ? `,${tail}` : ''
	const graph = circle
		? `${CIRCLE_MASK}[m];[0:v]${chain}scale=512:512:flags=lanczos,format=rgba[v];[v][m]alphamerge${end}[out]`
		: `[0:v]${chain}${FIT_512}${end}[out]`
	return ['-filter_complex', graph, '-map', '[out]']
}

/**
 * Imagen (jpg/png/webp estático...) -> sticker webp estático 512x512.
 * square: true -> recorta un cuadrado al centro en vez de dejar fondo transparente.
 * circle: true -> recorta en círculo.
 */
export async function imageToSticker(buffer, { square = false, circle = false } = {}) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		await fs.writeFile(input, buffer)
		const crop = square || circle ? cropFilter(null, true) : ''
		let best
		for (const quality of [80, 65, 50, 35, 20]) {
			const output = path.join(dir, `out-${quality}.webp`)
			await run(FFMPEG, [
				'-y', '-i', input, ...stickerFilter(crop, { circle }), '-frames:v', '1',
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
 * maxSeconds: cuántos segundos del video original se usan (desde start).
 * squareCrop: 'auto'   -> si tiene bordes negros, los quita y recorta a 1:1
 *             'always' -> siempre recorta a 1:1 (y quita bordes si hay)
 *             'never'  -> deja el video completo con fondo transparente
 * circle: recorta en círculo (quitando antes los bordes negros).
 * speed: 1.5 = más rápido, 0.75 = más lento. reverse: al revés.
 */
export async function videoToSticker(buffer, {
	start = 0, maxSeconds = 10, squareCrop = 'auto', circle = false, speed = 1, reverse = false
} = {}) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		await fs.writeFile(input, buffer)
		let box = null
		if (squareCrop !== 'never' || circle) {
			box = await detectBlackBars(input, { start, seconds: maxSeconds }).catch(() => null)
		}
		const square = circle || squareCrop === 'always' || (squareCrop !== 'never' && box)
		const crop = square ? cropFilter(box, true) : ''
		const pts = speed !== 1 ? `setpts=PTS/${speed},` : ''
		let best
		const attempts = [
			{ fps: 15, quality: 60 },
			{ fps: 12, quality: 45 },
			{ fps: 10, quality: 35 },
			{ fps: 8, quality: 25 },
			{ fps: 8, quality: 15 },
			{ fps: 6, quality: 10 },
			// Último recurso: más corto
			{ fps: 6, quality: 10, seconds: Math.min(maxSeconds, 6) },
			{ fps: 6, quality: 10, seconds: Math.min(maxSeconds, 4) }
		]
		for (const [i, a] of attempts.entries()) {
			const output = path.join(dir, `out-${i}.webp`)
			// a.seconds limita lo que dura el sticker; con speed se lee más o menos del original
			const seconds = a.seconds ? Math.min(maxSeconds, a.seconds * speed) : maxSeconds
			await run(FFMPEG, [
				'-y', '-ss', String(start), '-t', String(seconds), '-i', input,
				...stickerFilter(`${pts}fps=${a.fps},${crop}`, { circle, tail: reverse ? 'reverse' : '' }), '-an',
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
 * Sticker animado (webp) -> el mismo sticker al revés y/o más rápido o lento.
 * ffmpeg no siempre sabe leer webp animados, así que los cuadros se sacan con sharp (libwebp),
 * ya armados (los webp animados suelen guardar solo lo que cambia de un cuadro al otro).
 * No conserva los metadatos (exif).
 */
export async function retimeAnimatedSticker(buffer, { speed = 1, reverse = false } = {}) {
	const meta = await sharp(buffer, { animated: true }).metadata()
	const pages = meta.pages || 1
	const { data, info } = await sharp(buffer, { animated: true }).ensureAlpha().raw()
		.toBuffer({ resolveWithObject: true })
	const height = meta.pageHeight || info.height / pages
	const frameBytes = info.width * height * 4

	const order = [...Array(pages).keys()]
	if (reverse) order.reverse()
	const frames = Buffer.concat(order.map((i) => data.subarray(i * frameBytes, (i + 1) * frameBytes)))
	// Cada cuadro conserva su duración (dividida por la velocidad); menos de 20 ms no se respeta
	const delays = order.map((i) => Math.max(20, Math.round((meta.delay?.[i] ?? 100) / speed)))

	let best
	for (const quality of [75, 60, 45, 30, 20]) {
		best = await sharp(frames, { raw: { width: info.width, height: height * pages, channels: 4, pageHeight: height } })
			.webp({ quality, effort: 4, loop: meta.loop ?? 0, delay: delays })
			.toBuffer()
		if (best.length <= ANIMATED_MAX_BYTES) break
	}
	return best
}

/**
 * Efectos de sonido (filtros de ffmpeg), en el orden en que se aplican.
 * speed: cuánto cambia la duración (1.5 = dura 1/1.5). reverse: suena al revés.
 * Los cambios de tono mantienen la duración (asetrate cambia tono y velocidad, atempo la corrige).
 */
export const AUDIO_EFFECTS = {
	reversa: { filter: 'areverse', reverse: true },
	rapido: { filter: 'atempo=1.5', speed: 1.5 },
	lento: { filter: 'atempo=0.75', speed: 0.75 },
	grave: { filter: 'asetrate=36000,aresample=48000,atempo=1.3333' },
	ardilla: { filter: 'asetrate=72000,aresample=48000,atempo=0.6667' },
	eco: { filter: 'aecho=0.8:0.85:250|500:0.45|0.25' },
	bass: { filter: 'bass=g=18:f=90:w=0.6,volume=2,alimiter=limit=0.9' }
}

/**
 * Cualquier audio o video -> audio para el sticker con sonido.
 * maxSeconds: cuántos segundos del original se usan (desde start).
 * maxOutputSeconds: tope de lo que dura el resultado (el eco, por ejemplo, alarga un poco el final).
 * effects: nombres de AUDIO_EFFECTS.
 * Devuelve { buffer, seconds, mimetype }.
 */
export async function toStickerAudio(buffer, {
	start = 0, maxSeconds = 10, maxOutputSeconds = Infinity, format = 'opus', effects = []
} = {}) {
	const fmt = AUDIO_FORMATS[format]
	if (!fmt) throw new Error(`audioFormat desconocido: ${format} (usa "opus" o "aac")`)
	const unknown = effects.find((e) => !AUDIO_EFFECTS[e])
	if (unknown) throw new Error(`Efecto desconocido: ${unknown}`)
	// Primero a 48 kHz: los cambios de tono cuentan con esa frecuencia
	const af = effects.length ? ['-af', ['aresample=48000', ...effects.map((e) => AUDIO_EFFECTS[e].filter)].join(',')] : []
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		const output = path.join(dir, `audio.${fmt.ext}`)
		await fs.writeFile(input, buffer)
		const info = await probe(input)
		if (!info.hasAudio) throw new Error('Ese archivo no tiene audio.')
		await run(FFMPEG, [
			'-y', '-ss', String(start), '-t', String(maxSeconds), '-i', input,
			'-vn', '-map_metadata', '-1', ...af, '-ac', '1', '-ar', '48000',
			...(Number.isFinite(maxOutputSeconds) ? ['-t', String(maxOutputSeconds)] : []),
			...fmt.args, output
		])
		const { duration } = await probe(output)
		if (duration < 0.2) throw new Error('El audio quedó vacío (¿el inicio es mayor que la duración?).')
		return { buffer: await fs.readFile(output), seconds: Math.max(1, Math.round(duration)), mimetype: fmt.mimetype }
	})
}

/**
 * Video descargado -> mp4 (H.264 + AAC) que se reproduce en cualquier celular.
 * Si ya lo es, lo devuelve tal cual; si solo cambia el audio, no recodifica el video.
 */
export async function toShareableVideo(buffer) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		const output = path.join(dir, 'video.mp4')
		await fs.writeFile(input, buffer)
		const info = await probe(input)
		if (!info.hasVideo) throw new Error('Eso no tiene video.')
		const videoOk = info.videoCodec === 'h264'
		const audioOk = !info.hasAudio || info.audioCodec === 'aac'
		if (videoOk && audioOk && info.format.includes('mp4')) return buffer
		await run(FFMPEG, [
			'-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
			...(videoOk
				? ['-c:v', 'copy']
				: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
					'-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']),
			...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
			'-movflags', '+faststart', output
		])
		return fs.readFile(output)
	})
}

/** Cualquier audio o video -> mp3. Devuelve { buffer, seconds }. */
export async function toMp3(buffer) {
	return withTempDir(async (dir) => {
		const input = path.join(dir, 'input')
		const output = path.join(dir, 'audio.mp3')
		await fs.writeFile(input, buffer)
		if (!(await probe(input)).hasAudio) throw new Error('Eso no tiene audio.')
		await run(FFMPEG, ['-y', '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', output])
		const { duration } = await probe(output)
		return { buffer: await fs.readFile(output), seconds: Math.max(1, Math.round(duration)) }
	})
}

/** ¿El webp es animado? (bandera de animación en el chunk VP8X) */
export function isAnimatedWebp(buffer) {
	return buffer.length > 21 && buffer.toString('ascii', 12, 16) === 'VP8X' && (buffer[20] & 0x02) !== 0
}
