import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import ffmpeg from 'fluent-ffmpeg'
import { Readable } from 'stream'
import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import ytdl from '@distube/ytdl-core'
import sharp from 'sharp'

let ytdlAgent: ytdl.Agent
const configPath = process.env.YTDL_AGENT_CONFIG_PATH

if (configPath && fs.existsSync(configPath)) {
    console.log('Creating a YT Agent with Cookie!')
    // @ts-ignore
    ytdlAgent = ytdl.createAgent(JSON.parse(fs.readFileSync(configPath)))
} else {
    ytdlAgent = ytdl.createAgent()
}

// Validate if a string is base64 encoded
function isBase64(str: string): boolean {
    try {
        Buffer.from(str, 'base64').toString('base64')
        return true
    } catch (err) {
        return false
    }
}

interface AudioFile {
    buffer: Buffer
    timestamp: number
    metadata?: ffmpeg.FfprobeData
}

// Store files in memory (max 3 files)
const audioFiles = new Map<string, AudioFile>()
const conversionStatus = new Map<string, Promise<void>>()

// Function to maintain max 3 files using LRU
function maintainFileLimit() {
    if (audioFiles.size > 3) {
        let oldestFile: [string, number] | null = null
        for (const [filename, file] of audioFiles.entries()) {
            if (!oldestFile || file.timestamp < oldestFile[1]) {
                oldestFile = [filename, file.timestamp]
            }
        }
        if (oldestFile) {
            audioFiles.delete(oldestFile[0])
            conversionStatus.delete(oldestFile[0])
            console.log(`Removed oldest file: ${oldestFile[0]}`)
        }
    }
}

const app = new Hono()

app.get('/convert', async (c) => {
    const encodedUrl = c.req.query('url')
    const videoId = c.req.query('videoId')

    if (!encodedUrl && !videoId) {
        return c.json({ error: 'Missing url or videoId parameter' }, 400)
    }

    if (encodedUrl && !isBase64(encodedUrl)) {
        return c.json({ error: 'URL parameter must be base64 encoded' }, 400)
    }

    // Generate deterministic filename from videoId or url
    const filenameBase = videoId || crypto.createHash('md5').update(encodedUrl!).digest('hex')
    const filename = `${filenameBase}.mp3`

    // Create and store the conversion promise
    const conversionPromise = (async () => {
        try {
            let videoStream: Readable

            if (videoId) {
                videoStream = ytdl(videoId, {
                    //quality: 'highestaudio',
                    agent: ytdlAgent,
                })
            } else {
                const url = Buffer.from(encodedUrl!, 'base64').toString()
                videoStream = await new Promise<Readable>((resolve, reject) => {
                    const isHttps = url.startsWith('https:')
                    const client = isHttps ? https : http

                    client
                        .get(url, (response) => {
                            if (response.statusCode !== 200) {
                                reject(new Error(`Failed to fetch video: ${response.statusCode}`))
                                return
                            }
                            resolve(response as Readable)
                        })
                        .on('error', reject)
                })
            }

            // Convert the stream and store in memory
            const chunks: Buffer[] = []
            await new Promise<void>((resolve, reject) => {
                ffmpeg(videoStream as any)
                    .toFormat('mp3')
                    .audioBitrate(192)
                    .on('error', (err: Error) => {
                        console.error('Error during conversion:', err)
                        reject(err)
                    })
                    .on('end', () => {
                        const buffer = Buffer.concat(chunks)
                        audioFiles.set(filename, {
                            buffer,
                            timestamp: Date.now(),
                        })
                        maintainFileLimit()
                        resolve()
                    })
                    .pipe()
                    .on('data', (chunk: Buffer) => chunks.push(chunk))
            })
        } catch (error) {
            console.error('Conversion error:', error)
            throw error
        }
    })()

    // Store the conversion promise and handle cleanup on error
    conversionStatus.set(filename, conversionPromise)
    conversionPromise.catch(() => {
        conversionStatus.delete(filename)
        audioFiles.delete(filename)
        console.error(`Conversion failed for ${filename}`)
    })

    // Return the URL immediately
    const host = c.req.header('host') || 'localhost:3000'
    const protocol = c.req.header('x-forwarded-proto') || 'http'
    const fileUrl = `${protocol}://${host}/audio/${filename}`

    return c.json({ url: fileUrl, status: 'converting' })
})

// Get audio file information
app.get('/audio/:filename/info', async (c) => {
    const filename = c.req.param('filename')
    const audioFile = audioFiles.get(filename)
    if (!audioFile) {
        return c.json({ error: 'File not found' }, 404)
    }

    // Get file information using ffmpeg
    try {
        // Use cached metadata if available
        if (!audioFile.metadata) {
            // Create a temporary file for ffprobe since it requires a file path
            const tempPath = path.join(process.cwd(), `${filename}.temp`)
            try {
                fs.writeFileSync(tempPath, audioFile.buffer)
                audioFile.metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
                    ffmpeg.ffprobe(tempPath, (err, metadata) => {
                        if (err) reject(err)
                        else resolve(metadata)
                    })
                })
            } finally {
                // Ensure temp file is deleted even if ffprobe fails
                try {
                    fs.rmSync(tempPath, { force: true })
                } catch (e) {
                    console.error('Error deleting temp file:', e)
                }
            }
        }

        const info = audioFile.metadata

        const audioStream = info.streams.find((stream) => stream.codec_type === 'audio')
        if (!audioStream) {
            return c.json({ error: 'No audio stream found' }, 500)
        }

        return c.json({
            duration: info.format.duration,
            bitrate: info.format.bit_rate,
            size: info.format.size,
            format: info.format.format_name,
            codec: audioStream.codec_name,
            sampleRate: audioStream.sample_rate,
            channels: audioStream.channels,
        })
    } catch (error) {
        console.error('Error getting audio info:', error)
        return c.json({ error: 'Failed to get audio information' }, 500)
    }
})

// Stream audio directly without buffering
app.get('/stream', async (c) => {
    const videoId = c.req.query('videoId')

    if (!videoId) {
        return c.json({ error: 'Missing videoId parameter' }, 400)
    }

    try {
        // Generate deterministic filename
        const filename = `${videoId}.mp3`

        // Get video info first to calculate content length
        const info = await ytdl.getInfo(videoId, { agent: ytdlAgent })
        const lengthSeconds = parseInt(info.videoDetails.lengthSeconds)
        // Calculate content length: bitrate * duration in seconds
        // 192kbps = 24KB/s, add 8KB/s overhead for mp3 headers etc.
        const contentLength = Math.ceil(lengthSeconds * (24 + 8) * 1024)

        const videoStream = ytdl(videoId, {
            quality: 'highestaudio',
            agent: ytdlAgent,
        })

        // Set up the ffmpeg command
        const command = ffmpeg(videoStream).toFormat('mp3').audioBitrate(192)

        // Get a readable stream from ffmpeg
        const stream = command.pipe() as unknown as Readable

        // Handle errors
        command.on('error', (err: Error) => {
            console.error('FFmpeg error:', err)
            stream.destroy(err)
        })

        return new Response(Readable.toWeb(stream) as ReadableStream, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'transfermode.dlna.org': 'Streaming',
                'Content-Length': contentLength.toString(),
                'Content-Disposition': `attachment; filename="${filename}"`,
            },
        })
    } catch (error) {
        console.error('Streaming error:', error)
        return c.json({ error: 'Failed to stream audio' }, 500)
    }
})

// Serve MP3 files
app.get('/audio/:filename', async (c) => {
    const filename = c.req.param('filename')
    // Check if file exists and handle conversion status
    const conversion = conversionStatus.get(filename)
    if (conversion) {
        try {
            await conversion
            conversionStatus.delete(filename)
        } catch (error) {
            return c.json({ error: 'Conversion failed' }, 500)
        }
    }

    const audioFile = audioFiles.get(filename)
    if (!audioFile) {
        return c.json({ error: 'File not found' }, 404)
    }

    // Update timestamp (LRU)
    audioFile.timestamp = Date.now()

    // Create a fresh readable stream from the buffer for each request
    const stream = new Readable({
        read() {
            this.push(audioFile.buffer)
            this.push(null)
        },
    })

    return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
            'Content-Type': 'audio/mpeg',
            'transfermode.dlna.org': 'Streaming',
        },
    })
})

// Get YouTube thumbnail and process to 1:1 ratio
app.get('/thumbnail/:videoId', async (c) => {
    const videoIdParam = c.req.param('videoId')
    if (!videoIdParam) {
        return c.json({ error: 'Missing videoId parameter' }, 400)
    }
    const videoId = videoIdParam.replace('.jpg', '') // Remove .jpg extension
    const imageUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`

    try {
        // Fetch the image
        const response = await fetch(imageUrl)
        if (!response.ok) {
            return c.json({ error: 'Failed to fetch thumbnail' }, 404)
        }

        const imageBuffer = await response.arrayBuffer()

        // Process the image
        const image = sharp(Buffer.from(imageBuffer))
        const metadata = await image.metadata()

        if (!metadata.width || !metadata.height) {
            return c.json({ error: 'Invalid image metadata' }, 500)
        }

        // Calculate dimensions for center-focused square crop
        const size = Math.min(metadata.width, metadata.height)
        const left = Math.max(0, Math.floor((metadata.width - size) / 2))
        const top = Math.max(0, Math.floor((metadata.height - size) / 2))

        // Process image: crop to square and resize if needed
        const processedImageBuffer = await image
            .extract({ left, top, width: size, height: size })
            .resize(720, 720, { fit: 'fill' }) // Standardize size to 500x500
            .jpeg({ quality: 85 }) // Convert to JPEG with good quality
            .toBuffer()

        // Return the processed image
        return new Response(processedImageBuffer, {
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=31536000',
            },
        })
    } catch (error) {
        console.error('Error processing thumbnail:', error)
        return c.json({ error: 'Failed to process thumbnail' }, 500)
    }
})

// Start the server
const port = Number(process.env.SERVER_ENDPOINT ? process.env.SERVER_ENDPOINT.split(':').pop() : 3000)
console.log(`Server running at http://0.0.0.0:${port}`)

serve({
    fetch: app.fetch,
    port,
    hostname: '0.0.0.0',
})
