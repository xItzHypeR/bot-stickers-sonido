// Reintentos para fallas pasajeras de red (descargas de WhatsApp, etc.).

const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|terminated|other side closed/i

/** Código o motivo de red de un error de fetch (el detalle viene en err.cause). */
export function networkReason(err) {
	const cause = err?.cause
	return cause?.code || cause?.message || err?.code || ''
}

/** ¿Es una falla de conexión (vale la pena reintentar)? */
export function isNetworkError(err) {
	return NETWORK.test(`${err?.message ?? ''} ${networkReason(err)}`)
}

/** Ejecuta fn y la reintenta si falla por la red (espera 1 s, 2 s...). */
export async function retryOnNetworkError(fn, { attempts = 3, delayMs = 1000 } = {}) {
	for (let i = 1; ; i++) {
		try {
			return await fn()
		} catch (err) {
			if (i >= attempts || !isNetworkError(err)) throw err
			await new Promise((resolve) => setTimeout(resolve, delayMs * i))
		}
	}
}
