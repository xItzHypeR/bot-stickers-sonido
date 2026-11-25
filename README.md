# Bot de stickers con sonido para WhatsApp

Bot personal que corre en tu PC, se vincula a tu WhatsApp como "dispositivo vinculado" (igual que WhatsApp Web) y crea:

- **Stickers normales** de imágenes, videos y GIFs.
- **Stickers con sonido** 🔊 (el formato nuevo de WhatsApp): de un video con su audio, o de una imagen/sticker + un audio o nota de voz.

## Requisitos

- [Node.js](https://nodejs.org) 20 o más nuevo
- [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) en el PATH (`ffmpeg -version` debe funcionar)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) para los links de TikTok: `python -m pip install -U "yt-dlp[default]"`

## Arrancar

```powershell
npm install
npm start
```

Aparece un QR en la terminal. En tu celular: **WhatsApp → Dispositivos vinculados → Vincular dispositivo** y escanéalo.

Si prefieres un código en vez de QR (con tu número y código de país, solo dígitos):

```powershell
npm start -- --numero 5215512345678
```

La sesión se guarda en la carpeta `auth/`, así que la próxima vez ya no pide QR. Para dejar de usarlo, cierra la sesión desde el celular (Dispositivos vinculados) y borra `auth/`.

## Comandos

Escríbelos tú mismo en cualquier chat. Lo más cómodo es usar tu chat contigo mismo ("Tú" / "Mensajes para mí") y luego reenviar el sticker a quien quieras: en otros chats la otra persona también ve los comandos y las respuestas del bot.

| Comando | Qué hace |
|---|---|
| `!menu` | Muestra la ayuda |
| `!s` | Responde a una imagen, video o GIF (o mándalo con `!s` como texto) → sticker |
| `!ss` respondiendo a un **video** | Sticker animado con el audio del video |
| `!ss` respondiendo a un **link de TikTok**, o `!ss <link>` | Descarga el video y hace el sticker animado con su audio |
| `!s <link>` | Sticker animado (sin sonido) de un TikTok |
| `!ss` respondiendo a una **imagen o sticker** | El bot te pide el audio: manda un audio, nota de voz o link de TikTok (usa su sonido) |
| `!ss` respondiendo a un **audio** | El bot te pide la imagen, sticker o video |
| `!expropiar Paquete\|Autor` | Responde a un sticker (con o sin sonido) → te lo devuelve con tu nombre de paquete y autor. Sin texto usa los de la configuración |
| `!video <link>` | Descarga el video (TikTok, Instagram, X, YouTube…) y te lo manda |
| `!mp3 <link>` | Descarga solo el audio en mp3 (también `!musica`) |
| `!audio` | Responde a un sticker con sonido → te manda su audio |
| `!info` | Responde a un mensaje → muestra cómo viene por dentro (sirve para depurar) |
| `!cancelar` | Cancela un sticker con sonido a medias |

### Opciones de `!s` y `!ss`

Se escriben después del comando, en cualquier orden y combinadas: `!ss 3-8 ardilla redondo <link>`.

| Opción | Qué hace |
|---|---|
| `3` | Empieza en el segundo 3 |
| `3-8` | Usa del segundo 3 al 8 (también `1:05-1:10`) |
| `1:1` (o `cuadrado`) | Recorte cuadrado al centro |
| `redondo` | Sticker en círculo |
| `grave` / `ardilla` | Voz más grave / más aguda (dura lo mismo) |
| `eco` | Eco |
| `bass` | Bajos a tope |
| `reversa` | Al revés |
| `rapido` / `lento` | 1,5× más rápido / más lento |

`rapido`, `lento` y `reversa` también se aplican al video del sticker. Con `!s` solo cuentan las opciones de imagen y video (los efectos de sonido no aplican).

El audio se recorta a 10 s y los stickers animados a 6 s (se cambia en [src/config.js](src/config.js)).

Si un video (por ejemplo un TikTok) tiene bordes negros arriba/abajo o a los lados, el bot los detecta, los quita y deja el sticker cuadrado (1:1). Los textos que estén dentro del borde negro se conservan. Con `squareCrop` en la configuración puedes hacer que recorte siempre a 1:1 (`'always'`) o nunca (`'never'`). Para forzarlo en un solo sticker, agrega `1:1` al comando.

Los links también funcionan con Instagram, YouTube Shorts, X y otros sitios que soporte yt-dlp (los públicos; los que piden iniciar sesión no). Solo se aceptan sitios conocidos, no links a cualquier página. Si TikTok empieza a fallar seguido, actualiza yt-dlp con `python -m pip install -U "yt-dlp[default]"`: TikTok cambia a menudo y yt-dlp se actualiza para seguirle el paso. TikTok bloquea algunos videos por región y esos no se pueden descargar.

## Configuración

Todo está en [src/config.js](src/config.js): prefijo, nombre del paquete y autor, límites de duración, recorte de bordes negros (`squareCrop`) y formato del audio.

Los datos personales van en `src/config.local.js`, que no se sube a GitHub. Ahí va `owners`: números extra que pueden usar el bot (tus amigos, o el tuyo si lo corres en un segundo número). Para crearlo, copia [src/config.local.example.js](src/config.local.example.js) como `src/config.local.js` y pon los números. Cualquier opción de `config.js` que pongas ahí la reemplaza.

## Cómo funciona el sticker con sonido

WhatsApp manda el sticker con sonido así: un `audioStickerMessage` (campo 134) que envuelve un `stickerMessage` normal y, dentro de él, un `audioMessage` (campo 26) con el audio subido por separado. Los números de campo salen del protobuf de WhatsApp Web.

Baileys (la librería que usa el bot) todavía no conoce ese formato, así que el bot trae un parche en [patches/](patches/) que se aplica automáticamente con `npm start`. Si actualizas Baileys a otra versión, el parche deja de aplicar y hay que rehacerlo.

## Ten en cuenta

- **No es oficial.** Baileys es una librería no oficial; WhatsApp puede bloquear números que usan clientes no oficiales. Para uso personal y tranquilo el riesgo es bajo, pero existe. Si te preocupa, úsalo con un segundo número y pon tu número personal en `owners`.
- **La función es muy nueva.** Quien recibe el sticker necesita una versión de WhatsApp que ya tenga stickers con sonido; con una versión vieja puede verlo como sticker sin sonido o como mensaje no compatible.
- **Formato del audio.** El bot usa Opus (como las notas de voz). Si al probar no suena, responde con `!info` a un sticker con sonido que te haya mandado otra persona, mira el `mimetype` del audio y, si es `audio/mp4`, cambia `audioFormat` a `'aac'` en la configuración.
- La carpeta `auth/` es tu sesión de WhatsApp: no la compartas ni la subas a internet.

## Pruebas

```powershell
npm test
```

Comprueba, sin conectarse a WhatsApp, que el mensaje se codifica con los campos correctos y que las conversiones de ffmpeg funcionan.
