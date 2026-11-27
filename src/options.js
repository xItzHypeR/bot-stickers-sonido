// Opciones que se escriben después de !s / !ss:
//   3          -> empieza en el segundo 3
//   3-8        -> del segundo 3 al 8 (también 1:05-1:10)
//   1:1        -> recorte cuadrado (también "cuadrado")
//   redondo    -> sticker en círculo
//   grave, ardilla, eco, reversa, rapido, lento, bass, 8bit -> efectos
import { AUDIO_EFFECTS } from './media.js'

const SQUARE = new Set(['1:1', '1x1', 'cuadrado', 'cuadro'])
const CIRCLE = new Set(['redondo', 'circulo', 'circular', 'circle'])
const EFFECT_ALIASES = {
	grave: 'grave', gruesa: 'grave', grueso: 'grave',
	ardilla: 'ardilla', aguda: 'ardilla', agudo: 'ardilla', chipmunk: 'ardilla',
	eco: 'eco', echo: 'eco',
	reversa: 'reversa', reverso: 'reversa', alreves: 'reversa', reverse: 'reversa',
	rapido: 'rapido', fast: 'rapido',
	lento: 'lento', slow: 'lento',
	bass: 'bass', bajo: 'bass', bajos: 'bass', bassboost: 'bass',
	'8bit': '8bit', '8bits': '8bit', retro: '8bit', gameboy: '8bit'
}

// 3 · 2.5 · 2,5 · 1:05 (mm:ss; "1:1" no cuenta porque los segundos llevan dos cifras)
const TIME = String.raw`(?:\d{1,3}:[0-5]\d|\d+)(?:[.,]\d+)?`
const SINGLE = new RegExp(`^${TIME}$`)
const RANGE = new RegExp(`^(${TIME})-(${TIME})$`)

function toSeconds(text) {
	const [a, b] = text.replace(',', '.').split(':')
	return b === undefined ? parseFloat(a) : Number(a) * 60 + parseFloat(b)
}

/** Sin tildes y en minúsculas ("Rápido" -> "rapido") */
export function plain(text) {
	return String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * Lee las opciones de los argumentos del comando.
 * Devuelve { start, duration, square, circle, effects, speed, reverse }.
 * duration es null si no se dio un rango.
 */
export function parseOptions(args) {
	const opts = { start: 0, duration: null, square: false, circle: false, effects: [] }
	for (const raw of args) {
		const arg = plain(raw)
		if (/^https?:\/\//.test(arg)) continue
		if (SQUARE.has(arg)) opts.square = true
		else if (CIRCLE.has(arg)) opts.circle = true
		else if (EFFECT_ALIASES[arg]) {
			if (!opts.effects.includes(EFFECT_ALIASES[arg])) opts.effects.push(EFFECT_ALIASES[arg])
		} else if (RANGE.test(arg)) {
			const [, from, to] = arg.match(RANGE)
			const start = toSeconds(from)
			const end = toSeconds(to)
			if (end <= start) throw new Error(`En ${raw} el final tiene que ser mayor que el inicio.`)
			opts.start = start
			opts.duration = end - start
		} else if (SINGLE.test(arg)) {
			opts.start = toSeconds(arg)
		}
	}
	if (opts.effects.includes('rapido') && opts.effects.includes('lento')) {
		throw new Error('No se puede rápido y lento a la vez.')
	}
	// Orden fijo para que el resultado no dependa de cómo se escribieron
	const order = Object.keys(AUDIO_EFFECTS)
	opts.effects.sort((a, b) => order.indexOf(a) - order.indexOf(b))
	opts.speed = opts.effects.reduce((s, e) => s * (AUDIO_EFFECTS[e].speed || 1), 1)
	opts.reverse = opts.effects.some((e) => AUDIO_EFFECTS[e].reverse)
	return opts
}

/**
 * Cuántos segundos del original hay que leer para que el resultado dure como máximo maxOutput.
 * Con un rango se usa ese tramo; con "rapido" se lee más para llenar el sticker.
 */
export function inputSeconds(opts, maxOutput) {
	return Math.min(opts.duration ?? Infinity, maxOutput * opts.speed)
}

/**
 * Cuánto puede durar el sonido del sticker.
 * audio.fromVideo: sale del mismo video, así que dura lo mismo que la animación.
 * audio.ownSeconds: es el propio sonido de un sticker (al ponerle efectos); no se acorta,
 * porque WhatsApp ya lo aceptó así de largo.
 */
export function maxSoundSeconds(audio, opts, { maxAudioSeconds, maxVideoSeconds }) {
	if (audio.fromVideo) return Math.min(maxVideoSeconds, maxAudioSeconds)
	if (audio.ownSeconds) return Math.max(maxAudioSeconds, audio.ownSeconds / opts.speed)
	return maxAudioSeconds
}
