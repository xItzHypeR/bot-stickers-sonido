// Descarga de videos desde links (TikTok, Instagram, YouTube Shorts, X...) con yt-dlp.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { probe, withTempDir } from './media.js'

const MAX_MB = 50
const TIMEOUT_MS = 2 * 60 * 1000

// Formas de llamar a yt-dlp, en orden. Se recuerda la primera que funcione.
const CANDIDATES = process.env.YTDLP_PATH
	? [[process.env.YTDLP_PATH]]
	: [['yt-dlp'], ['python', '-m', 'yt_dlp'], ['python3', '-m', 'yt_dlp']]
let ytDlp

function exec(cmd, args) {
	return new Promise((resolve, reject) => {
		execFile(cmd[0], [...cmd.slice(1), ...args], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(String(stdout))))
	})
}

const isMissing = (err) => err.code === 'ENOENT' || /No module named yt_dlp/.test(err.stderr || '')

async function runYtDlp(args) {
	for (const cmd of ytDlp ? [ytDlp] : CANDIDATES) {
		try {
			const out = await exec(cmd, args)
			ytDlp = cmd
			return out
		} catch (err) {
			if (isMissing(err)) continue
			if (err.killed) throw new Error('La descarga tardó demasiado.')
			const line = (err.stderr || err.message).trim().split('\n').filter((l) => l.includes('ERROR')).pop() || err.message
			throw Object.assign(new Error(friendlyError(line)), {
				// Fallos pasajeros del sitio: vale la pena reintentar
				retryable: /Unexpected response|timed out|HTTP Error 5\d\d|Connection (reset|aborted)/i.test(line)
			})
		}
	}
	throw new Error('No está instalado yt-dlp. Instálalo con: python -m pip install -U "yt-dlp[default]"')
}

function friendlyError(line) {
	const msg = line.replace(/^ERROR:\s*/, '')
	if (/Unsupported URL|No suitable extractor/i.test(msg)) return 'Ese link no es de un sitio compatible.'
	if (/IP address is blocked|not available in your (country|region)/i.test(msg)) {
		return 'TikTok no deja descargar ese video desde aquí (bloqueo por región). Prueba con otro.'
	}
	if (/private|login|log in|sign in|cookies/i.test(msg)) return 'El video es privado o pide iniciar sesión.'
	if (/not available|removed|404/i.test(msg)) return 'El video no existe o ya no está disponible.'
	if (/Unexpected response|report this issue/i.test(msg)) {
		return 'El sitio no respondió bien con ese video. Prueba otra vez o con otro link (si pasa seguido, actualiza yt-dlp).'
	}
	return msg.replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
}

/** Primer link http(s) del texto, o null. */
export function findUrl(text) {
	const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i)
	return match ? match[0].replace(/[),.!?]+$/, '') : null
}

/**
 * Descarga el video de un link (o solo el audio con audioOnly).
 * Devuelve { buffer, hasVideo, hasAudio } (un TikTok de fotos puede traer solo audio).
 */
export async function downloadFromLink(url, { attempts = 3, audioOnly = false } = {}) {
	for (let i = 1; ; i++) {
		try {
			return await downloadOnce(url, audioOnly)
		} catch (err) {
			if (!err.retryable || i >= attempts) throw err
			await new Promise((r) => setTimeout(r, 1500 * i))
		}
	}
}

async function downloadOnce(url, audioOnly) {
	return withTempDir(async (dir) => {
		await runYtDlp([
			'--no-playlist', '--no-warnings', '--quiet', '--no-progress',
			'--ies', 'default,-generic', // solo sitios conocidos, nada de links arbitrarios
			'--max-filesize', `${MAX_MB}M`,
			...(audioOnly
				? ['-f', 'bestaudio/best']
				: ['-S', 'res:720,vcodec:h264,ext:mp4:m4a', '--merge-output-format', 'mp4']),
			...(process.env.FFMPEG_PATH ? ['--ffmpeg-location', process.env.FFMPEG_PATH] : []),
			'-o', path.join(dir, 'video.%(ext)s'),
			'--', url
		])
		const file = (await fs.readdir(dir)).find((f) => f.startsWith('video.') && !f.endsWith('.part'))
		if (!file) throw new Error(`No se pudo descargar (¿pesa más de ${MAX_MB} MB?).`)
		const full = path.join(dir, file)
		const info = await probe(full)
		if (!info.hasVideo && !info.hasAudio) throw new Error('Lo descargado no tiene ni video ni audio.')
		return { buffer: await fs.readFile(full), hasVideo: info.hasVideo, hasAudio: info.hasAudio }
	})
}
