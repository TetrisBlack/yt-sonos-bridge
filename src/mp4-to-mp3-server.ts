import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import ffmpeg from 'fluent-ffmpeg'
import { Readable, Writable } from 'stream'
import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { YtDlp } from 'ytdlp-nodejs'
import sharp from 'sharp'
import SonosPlayer from './SonosPlayer'



const ytdlp = process.env.YTDLP_BIN_PATH === undefined ? new YtDlp() : new YtDlp({
    binaryPath: process.env.YTDLP_BIN_PATH,
    ffmpegPath: process.env.FFMPEG_BIN_PATH
})

// Global SonosPlayer instance (will be set from index.ts)
let globalSonosPlayer: SonosPlayer | null = null

export function setSonosPlayer(player: SonosPlayer) {
    globalSonosPlayer = player
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
const conversionProgress = new Map<string, { progress: number, status: string }>()

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
            const videoStream: Buffer[] = []
            const memoryWriteStream = new Writable({
                write(chunk: Buffer, encoding, callback) {
                    videoStream.push(chunk)
                    callback()
                }
            })

            let readableStream: Readable
            
            if (videoId) {
                // Use ytdlp to download and get the stream directly with progress tracking
                const streamProcess = ytdlp.stream(`https://www.youtube.com/watch?v=${videoId}`, {
                    format: {
                        filter: 'audioonly'
                    },
                    onProgress: (progress) => {
                        const percent = progress.percentage || 0
                        console.log(`Download progress: ${percent}%`)
                        conversionProgress.set(filename, { 
                            progress: Math.round(percent * 0.8), // 80% for download, 20% for conversion
                            status: `Downloading... ${progress.downloaded_str || ''} / ${progress.total_str || ''}` 
                        })
                    }
                })
                conversionProgress.set(filename, { progress: 5, status: 'Starting download...' })
                await streamProcess.pipeAsync(memoryWriteStream)
                conversionProgress.set(filename, { progress: 80, status: 'Converting to MP3...' })
                
                // Convert buffer array to readable stream for ffmpeg
                const buffer = Buffer.concat(videoStream)
                readableStream = new Readable({
                    read() {
                        this.push(buffer)
                        this.push(null)
                    }
                })
            } else {
                const url = Buffer.from(encodedUrl!, 'base64').toString()
                readableStream = await new Promise<Readable>((resolve, reject) => {
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

            // Convert stream to MP3 using ffmpeg
            const chunks: Buffer[] = []
            await new Promise<void>((resolve, reject) => {
                ffmpeg(readableStream)
                    .toFormat('mp3')
                    .audioBitrate(192)
                    .on('error', (err: Error) => {
                        console.error('Error during conversion:', err)
                        reject(err)
                    })
                    .on('end', () => {
                        const finalBuffer = Buffer.concat(chunks)
                        audioFiles.set(filename, {
                            buffer: finalBuffer,
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
    conversionProgress.set(filename, { progress: 0, status: 'Starting conversion...' })
    
    conversionPromise.then(() => {
        conversionStatus.delete(filename)
        conversionProgress.set(filename, { progress: 100, status: 'Completed' })
        setTimeout(() => conversionProgress.delete(filename), 3000)
    }).catch(() => {
        conversionStatus.delete(filename)
        audioFiles.delete(filename)
        conversionProgress.set(filename, { progress: 0, status: 'Failed' })
        setTimeout(() => conversionProgress.delete(filename), 5000)
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

        // Get video info for duration calculation
        const info = await ytdlp.getInfoAsync<'video'>(`https://www.youtube.com/watch?v=${videoId}`)
        const lengthSeconds = info.duration || 0
        const contentLength = Math.ceil(lengthSeconds * (24 + 8) * 1024)

        // Stream MP3 directly from ytdlp
        const process = ytdlp.download(`https://www.youtube.com/watch?v=${videoId}`, {
            format: {
                filter: 'audioonly',
                quality: 10,
                type: 'mp3'
            },
            output: '-'
        })
        const stream = process.stdout as Readable

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
    console.log(`Serving audio file: ${filename}`)

    // Check if file exists and handle conversion status
    const conversion = conversionStatus.get(filename)
    if (conversion) {
        console.log(`Waiting for conversion to complete: ${filename}`)
        try {
            await conversion
            conversionStatus.delete(filename)
            console.log(`Conversion completed: ${filename}`)
        } catch (error) {
            console.error(`Conversion failed: ${filename}`, error)
            return c.json({ error: 'Conversion failed' }, 500)
        }
    }

    const audioFile = audioFiles.get(filename)
    if (!audioFile) {
        console.log(`File not found in cache: ${filename}`)
        return c.json({ error: 'File not found' }, 404)
    }

    console.log(`Streaming cached file: ${filename} (${audioFile.buffer.length} bytes)`)

    // Update timestamp (LRU)
    audioFile.timestamp = Date.now()

    const contentLength = audioFile.buffer.length

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
            'Content-Length': contentLength.toString(),
            'Content-Disposition': `attachment; filename="${filename}"`,
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
        return new Response(new Uint8Array(processedImageBuffer), {
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

// Sonos control endpoints
app.post('/sonos/play', async (c) => {
    const { filename } = await c.req.json()
    console.log(`Playing file on Sonos: ${filename}`)

    if (!globalSonosPlayer) {
        return c.json({ status: 'error', message: 'SonosPlayer not initialized' }, 500)
    }

    try {
        const host = process.env.SERVER_ENDPOINT || c.req.header('host') || 'localhost:3000'
        const fileUrl = `${host}/audio/${filename}`

        // Direct Sonos playback using the file URL
        await globalSonosPlayer.sonos.AVTransportService.SetAVTransportURI({
            InstanceID: 0,
            CurrentURI: fileUrl,
            CurrentURIMetaData: ''
        })
        await globalSonosPlayer.sonos.Play()

        return c.json({ status: 'success', message: `Playing ${filename}` })
    } catch (error) {
        console.error('Error playing on Sonos:', error)
        return c.json({ status: 'error', message: 'Failed to play on Sonos' }, 500)
    }
})

app.post('/sonos/pause', async (c) => {
    console.log('Pausing Sonos playback')

    if (!globalSonosPlayer) {
        return c.json({ status: 'error', message: 'SonosPlayer not initialized' }, 500)
    }

    try {
        await globalSonosPlayer.sonos.Pause()
        return c.json({ status: 'success', message: 'Paused' })
    } catch (error) {
        console.error('Error pausing Sonos:', error)
        return c.json({ status: 'error', message: 'Failed to pause' }, 500)
    }
})

app.post('/sonos/resume', async (c) => {
    console.log('Resuming Sonos playback')

    if (!globalSonosPlayer) {
        return c.json({ status: 'error', message: 'SonosPlayer not initialized' }, 500)
    }

    try {
        await globalSonosPlayer.sonos.Play()
        return c.json({ status: 'success', message: 'Resumed' })
    } catch (error) {
        console.error('Error resuming Sonos:', error)
        return c.json({ status: 'error', message: 'Failed to resume' }, 500)
    }
})

app.post('/sonos/stop', async (c) => {
    console.log('Stopping Sonos playback')

    if (!globalSonosPlayer) {
        return c.json({ status: 'error', message: 'SonosPlayer not initialized' }, 500)
    }

    try {
        await globalSonosPlayer.sonos.Stop()
        return c.json({ status: 'success', message: 'Stopped' })
    } catch (error) {
        console.error('Error stopping Sonos:', error)
        return c.json({ status: 'error', message: 'Failed to stop' }, 500)
    }
})

app.post('/sonos/next', async (c) => {
    console.log('Skipping to next track')

    if (!globalSonosPlayer) {
        return c.json({ status: 'error', message: 'SonosPlayer not initialized' }, 500)
    }

    try {
        await globalSonosPlayer.sonos.Next()
        return c.json({ status: 'success', message: 'Next track' })
    } catch (error) {
        console.error('Error skipping to next:', error)
        return c.json({ status: 'error', message: 'Failed to skip to next' }, 500)
    }
})

app.post('/sonos/previous', async (c) => {
    console.log('Going to previous track')

    if (!globalSonosPlayer) {
        return c.json({ status: 'error', message: 'SonosPlayer not initialized' }, 500)
    }

    try {
        await globalSonosPlayer.sonos.Previous()
        return c.json({ status: 'success', message: 'Previous track' })
    } catch (error) {
        console.error('Error going to previous:', error)
        return c.json({ status: 'error', message: 'Failed to go to previous' }, 500)
    }
})

// Get video info from YouTube
app.get('/video/:videoId/info', async (c) => {
    const videoId = c.req.param('videoId')
    
    try {
        const info = await ytdlp.getInfoAsync<'video'>(`https://www.youtube.com/watch?v=${videoId}`)
        return c.json({
            title: info.title,
            duration: info.duration,
            uploader: info.uploader,
            view_count: info.view_count,
            upload_date: info.upload_date,
            description: info.description?.substring(0, 200) + '...',
            thumbnail: info.thumbnail
        })
    } catch (error) {
        return c.json({ error: 'Failed to get video info' }, 500)
    }
})

// SSE endpoint for real-time progress updates
app.get('/admin/progress-stream', (c) => {
    return streamSSE(c, async (stream) => {
        while (true) {
            const progressInfo = Array.from(conversionProgress.entries()).map(([filename, progress]) => ({
                filename,
                ...progress
            }))
            
            await stream.writeSSE({
                data: JSON.stringify({ conversions: progressInfo })
            })
            
            await stream.sleep(500)
        }
    })
})

// Admin overview endpoint
app.get('/admin', async (c) => {
    const cacheInfo = Array.from(audioFiles.entries()).map(([filename, file]) => ({
        filename,
        size: file.buffer.length,
        timestamp: new Date(file.timestamp).toISOString()
    }))

    const conversionInfo = Array.from(conversionStatus.keys())

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>YT-Sonos Bridge Admin</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
            .test-btn { padding: 10px 20px; margin: 5px; background: #007cba; color: white; border: none; cursor: pointer; }
        </style>
    </head>
    <body>
        <h1>YT-Sonos Bridge Admin</h1>
        
        <div class="section">
            <h2>Cache Status</h2>
            <p>Files in cache: ${cacheInfo.length}/3</p>
            <table>
                <tr><th></th><th>Filename</th><th>Size (bytes)</th><th>Cached At</th><th>Actions</th></tr>
                ${cacheInfo.map(file => {
                    const videoId = file.filename.replace('.mp3', '')
                    return `<tr><td><img src="/thumbnail/${videoId}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;" onerror="this.style.display='none'"></td><td>${file.filename}</td><td>${file.size}</td><td>${file.timestamp}</td><td><button class="test-btn" style="padding: 5px 10px; margin: 0;" onclick="showVideoInfo('${videoId}')">Info</button></td></tr>`
                }).join('')}
            </table>
        </div>
        
        <div class="section">
            <h2>Active Conversions</h2>
            <p>Converting: ${conversionInfo.length}</p>
            <div id="conversions">
                ${conversionInfo.map(filename => {
                    const progress = conversionProgress.get(filename) || { progress: 0, status: 'Starting...' }
                    return `
                        <div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                            <div style="font-weight: bold;">${filename}</div>
                            <div style="margin: 5px 0; font-size: 12px; color: #666;">${progress.status}</div>
                            <div style="width: 100%; background: #f0f0f0; border-radius: 10px; height: 20px;">
                                <div style="width: ${progress.progress}%; background: #007cba; height: 100%; border-radius: 10px; transition: width 0.3s;"></div>
                            </div>
                            <div style="text-align: right; font-size: 12px; margin-top: 2px;">${progress.progress}%</div>
                        </div>
                    `
                }).join('')}
            </div>
        </div>
        
        <div class="section">
            <h2>Convert Video</h2>
            <input type="text" id="videoId" placeholder="Enter YouTube Video ID" style="width: 300px; padding: 8px;">
            <button class="test-btn" onclick="convertVideo()">Convert</button>
        </div>
        
        <div class="section">
            <h2>Queue & Sonos Controls</h2>
            <select id="queueSelect" style="width: 300px; padding: 8px; margin-bottom: 10px;">
                <option value="">Select cached file to play</option>
                ${cacheInfo.map(file => `<option value="${file.filename}">${file.filename}</option>`).join('')}
            </select><br>
            <button class="test-btn" onclick="playSelected()">Play Selected</button>
            <button class="test-btn" onclick="sonosControl('pause')">Pause</button>
            <button class="test-btn" onclick="sonosControl('resume')">Resume</button>
            <button class="test-btn" onclick="sonosControl('stop')">Stop</button>
            <button class="test-btn" onclick="sonosControl('next')">Next</button>
            <button class="test-btn" onclick="sonosControl('previous')">Previous</button>
        </div>
        
        <div class="section">
            <h2>Test Results</h2>
            <div id="test-results" style="margin-top: 10px; padding: 10px; background: #f5f5f5;"></div>
        </div>
        
        <script>
            async function convertVideo() {
                const videoId = document.getElementById('videoId').value;
                const results = document.getElementById('test-results');
                
                if (!videoId) {
                    results.innerHTML = 'Please enter a video ID';
                    return;
                }
                
                results.innerHTML = 'Converting video...';
                try {
                    const response = await fetch('/convert?videoId=' + encodeURIComponent(videoId));
                    const data = await response.json();
                    results.innerHTML = 'Convert result: ' + JSON.stringify(data, null, 2);
                    setTimeout(() => location.reload(), 2000); // Refresh to show new cache
                } catch (error) {
                    results.innerHTML = 'Convert failed: ' + error.message;
                }
            }
            
            async function playSelected() {
                const filename = document.getElementById('queueSelect').value;
                const results = document.getElementById('test-results');
                
                if (!filename) {
                    results.innerHTML = 'Please select a file from queue';
                    return;
                }
                
                results.innerHTML = 'Playing selected file...';
                try {
                    const response = await fetch('/sonos/play', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename })
                    });
                    const data = await response.json();
                    results.innerHTML = 'Play result: ' + JSON.stringify(data, null, 2);
                } catch (error) {
                    results.innerHTML = 'Play failed: ' + error.message;
                }
            }
            
            async function sonosControl(action) {
                const results = document.getElementById('test-results');
                results.innerHTML = 'Sending ' + action + ' command...';
                
                try {
                    const response = await fetch('/sonos/' + action, { method: 'POST' });
                    const data = await response.json();
                    results.innerHTML = action + ' result: ' + JSON.stringify(data, null, 2);
                } catch (error) {
                    results.innerHTML = action + ' failed: ' + error.message;
                }
            }
            
            async function showVideoInfo(videoId) {
                const results = document.getElementById('test-results');
                results.innerHTML = 'Loading video info...';
                
                try {
                    const response = await fetch('/video/' + videoId + '/info');
                    const data = await response.json();
                    
                    if (data.error) {
                        results.innerHTML = 'Error: ' + data.error;
                        return;
                    }
                    
                    results.innerHTML = \`
                        <div style="text-align: left;">
                            <h3>\${data.title}</h3>
                            <p><strong>Uploader:</strong> \${data.uploader}</p>
                            <p><strong>Duration:</strong> \${Math.floor(data.duration / 60)}:\${(data.duration % 60).toString().padStart(2, '0')}</p>
                            <p><strong>Views:</strong> \${data.view_count?.toLocaleString() || 'N/A'}</p>
                            <p><strong>Upload Date:</strong> \${data.upload_date}</p>
                            <p><strong>Description:</strong> \${data.description}</p>
                        </div>
                    \`;
                } catch (error) {
                    results.innerHTML = 'Failed to load video info: ' + error.message;
                }
            }
            
            // Use SSE for real-time progress updates
            const eventSource = new EventSource('/admin/progress-stream');
            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.conversions) {
                    const conversionsDiv = document.getElementById('conversions');
                    if (data.conversions.length === 0) {
                        conversionsDiv.innerHTML = '<p>No active conversions</p>';
                    } else {
                        conversionsDiv.innerHTML = data.conversions.map(conv => \`
                            <div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                                <div style="font-weight: bold;">\${conv.filename}</div>
                                <div style="margin: 5px 0; font-size: 12px; color: #666;">\${conv.status}</div>
                                <div style="width: 100%; background: #f0f0f0; border-radius: 10px; height: 20px;">
                                    <div style="width: \${conv.progress}%; background: #007cba; height: 100%; border-radius: 10px; transition: width 0.3s;"></div>
                                </div>
                                <div style="text-align: right; font-size: 12px; margin-top: 2px;">\${conv.progress}%</div>
                            </div>
                        \`).join('');
                    }
                }
            };
        </script>
    </body>
    </html>
    `

    return c.html(html)
})

// Start the server
const port = Number(process.env.SERVER_ENDPOINT ? process.env.SERVER_ENDPOINT.split(':').pop() : 3000)
console.log(`Server running at http://0.0.0.0:${port}`)
console.log(`Admin panel available at http://0.0.0.0:${port}/admin`)

serve({
    fetch: app.fetch,
    port,
    hostname: '0.0.0.0',
})
