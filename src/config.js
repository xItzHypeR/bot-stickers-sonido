// Configuración del bot. Cambia lo que quieras y reinicia con `npm start`.
//
// Tus datos personales (como los números de `owners`) van en src/config.local.js,
// que NO se sube a GitHub. Para crearlo, copia src/config.local.example.js.
// Lo que pongas ahí reemplaza lo de este archivo.
const config = {
	// Prefijo de los comandos (!s, !ss, !menu...)
	prefix: '!',

	// Además de ti (los mensajes que tú envías desde tu cuenta), estos números
	// también pueden usar el bot. Con código de país, solo dígitos.
	// Ponlos en src/config.local.js, no aquí.
	owners: [],

	// Datos que aparecen en "Ver paquete" del sticker
	packName: 'Mis stickers',
	author: 'HypeR',

	// Límites de los stickers con sonido.
	// WhatsApp permite hasta ~10 s de audio en stickers con sonido.
	maxAudioSeconds: 10,
	// Duración máxima de los stickers animados (de videos/GIF).
	maxVideoSeconds: 6,

	// Recorte de los stickers de video (TikToks, videos, GIFs):
	//  'auto'   -> si el video tiene bordes negros, los quita y lo deja cuadrado (1:1)
	//  'always' -> siempre lo recorta cuadrado al centro (y quita bordes negros si hay)
	//  'never'  -> deja el video completo, con fondo transparente donde sobre
	squareCrop: 'auto',

	// Formato del audio dentro del sticker con sonido:
	//  'opus' -> audio/ogg; codecs=opus (como las notas de voz) [recomendado]
	//  'aac'  -> audio/mp4
	// Usa !info respondiendo a un sticker con sonido de otra persona para ver
	// qué formato usa WhatsApp y cámbialo aquí si hace falta.
	audioFormat: 'opus',

	// Tiempo que el bot espera el audio/imagen que falta (en milisegundos)
	pendingTimeoutMs: 2 * 60 * 1000,

	// Carpeta donde se guarda la sesión de WhatsApp (no la compartas)
	authFolder: 'auth'
}

async function loadLocal() {
	try {
		return (await import('./config.local.js')).default || {}
	} catch (err) {
		// Si no existe config.local.js, se usa solo lo de arriba
		if (err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('config.local.js')) return {}
		throw err
	}
}

export default { ...config, ...(await loadLocal()) }
