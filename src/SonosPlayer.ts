import { Timer } from 'timer-node'
import { Player, type PlayerState, PLAYER_STATUSES, type Volume } from 'yt-cast-receiver'
import type Video from 'yt-cast-receiver/dist/mjs/lib/app/Video'
import VideoLoader from './VideoLoader'
import type { SonosDevice } from '@svrooij/sonos'
import { secondsToTimeString, timeStringToSeconds } from './utils/time'
import { getIdFromUrl } from './utils/uri'
import { EventEmitter } from 'events'

// sonos setup end
/**
 * Represents the current state of the Sonos player.
 * This state is emitted through the 'fakeState' event.
 */
export interface SonosState {
    /** Current playback status code */
    status: number
    /** Title of the currently playing video */
    videoTitle: string
    /** Current playback position in seconds */
    position: number
    /** Total duration of current track in seconds */
    duration: number
    /** Current volume settings */
    volume: Volume
}

/**
 * Custom implementation of {@link Player} that integrates with Sonos speakers.
 * This class handles:
 * - YouTube video playback through Sonos speakers
 * - Synchronization between YouTube cast events and Sonos playback
 * - Queue management and track transitions
 * - Volume control and playback position tracking
 *
 * Uses a timer to simulate playback and [YouTube.js](https://github.com/LuanRT/YouTube.js)
 * for fetching video info (see {@link VideoLoader}).
 */
export default class SonosPlayer extends Player {
    videoLoader: VideoLoader
    currentVideoId: string | null
    currentVideoTitle: string | null
    timer: Timer
    seekOffset: number
    duration: number
    timeout: NodeJS.Timeout | null
    volume: Volume
    currentFileUrl: string
    preloadFile: boolean
    sonos: SonosDevice
    sonosIsPlaying: boolean
    sonosTrackId: string
    sonosNextTrackTitle: string
    sonosCrossfade: boolean
    sonosStateEmitter: EventEmitter
    ownIpServerEndpoint: string

    constructor(sonos: SonosDevice, ownIpServerEndpoint: string) {
        super()
        this.videoLoader = new VideoLoader()
        this.currentVideoId = null
        this.currentVideoTitle = null
        this.timer = new Timer()
        this.seekOffset = 0
        this.duration = 0
        this.timeout = null
        this.currentFileUrl = ''
        this.preloadFile = false
        this.volume = {
            level: 50,
            muted: false,
        }
        this.sonos = sonos
        this.ownIpServerEndpoint = ownIpServerEndpoint

        this.sonos.LoadDeviceData()
        this.sonosStateEmitter = new EventEmitter()

        this.sonos.AVTransportService.Events.on('serviceEvent', (data) => {
            if (data.NextAVTransportURI) console.log(`NextAVTransportURI: ${data.NextAVTransportURI}`)
            if (data.CurrentTrackURI) console.log(`CurrentTrackURI: ${data.CurrentTrackURI}`)
            if (typeof data.CurrentTrackMetaData !== 'string')
                console.log(`CurrentTrackMetaData: ${data.CurrentTrackMetaData?.AlbumArtUri ?? 'not available'}`)
            if (data.TransportState) console.log(`TransportState: ${data.TransportState}`)
            if (data.TransportErrorDescription)
                console.log(`TransportErrorDescription: ${data.TransportErrorDescription}`)

            switch (data.TransportState) {
                case 'STOPPED':
                    this.sonosStateEmitter.emit('STOPPED', data)
                    break
                case 'PLAYING':
                    this.sonosStateEmitter.emit('PLAYING', data)
                    break
                case 'TRANSITIONING':
                    this.sonosStateEmitter.emit('TRANSITIONING', data)
                    break
                case 'PAUSED_PLAYBACK':
                    this.sonosStateEmitter.emit('PAUSED_PLAYBACK', data)
                    break
                default:
                    break
            }
        })

        setInterval(async () => {
            const result = await this.sonos.RefreshEventSubscriptions()
            console.log('Successfully refreshed the events %s', result)
        }, 15000)

        // Periodically sync local timer with Sonos playback position
        setInterval(() => {
            this.syncSeek()
        }, 3000)

        // When we receive a `state` event from the super class, signaling a change
        // in player state, we emit our own `fakeState` event for consumption.
        this.on('state', this.#emitFakeState.bind(this))

        this.sonosStateEmitter.on('STOPPED', async (data) => {
            const currentState = await this.getState()

            this.sonosIsPlaying = false
            this.sonosTrackId = getIdFromUrl(data?.CurrentTrackMetaData?.TrackUri)
            if (data?.NextAVTransportURI !== 0 && typeof data?.NextAVTransportURI === 'string')
                this.sonosNextTrackTitle = getIdFromUrl(data?.NextAVTransportURI)

            if (currentState.position > currentState.duration - 2) {
                this.logger.info(`[SonosPlayer]: Next was triggered by STOPPED EVENT`)
                this.next()
            }
        })

        this.sonosStateEmitter.on('TRANSITIONING', async (data) => {
            const currentState = await this.getState()

            this.sonosIsPlaying = false
            this.sonosTrackId = getIdFromUrl(data?.CurrentTrackMetaData?.TrackUri)
            if (currentState.position > currentState.duration - 2) {
                this.logger.info(`[SonosPlayer]: Next was triggered by TRANSITIONING EVENT`)
                this.next()
            }
        })

        this.sonosStateEmitter.on('PLAYING', async (data) => {
            const currentState = await this.getState()

            if (!this.sonosIsPlaying) {
                this.resume() // send yt client the pause message
                this.#sonosResume() // set the internal timers to stop
            }

            this.sonosIsPlaying = true
            this.sonosTrackId = getIdFromUrl(data?.CurrentTrackMetaData?.TrackUri)
            if (data?.NextAVTransportURI !== 0 && typeof data?.NextAVTransportURI === 'string')
                this.sonosNextTrackTitle = getIdFromUrl(data?.NextAVTransportURI)

            if (
                getIdFromUrl(data?.CurrentTrackMetaData?.TrackUri) !== this.currentVideoId &&
                currentState.position > currentState.duration - 2
            ) {
                this.logger.info(`[SonosPlayer]: Next was triggered by PLAYING EVENT`)
                this.sonosCrossfade = true
                this.next()
            }
        })

        this.sonosStateEmitter.on('PAUSED_PLAYBACK', async () => {
            const currentState = await this.getState()

            if (this.sonosIsPlaying === true && currentState.status === PLAYER_STATUSES.PLAYING) {
                this.pause() // send yt client the pause message
                this.#sonosPause() // set the internal timers to stop
                this.sonosIsPlaying = false
            }
        })

        // fallback continue
        setInterval(async () => {
            const currentState = await this.getState()
            const ignoreStates =
                currentState.status !== PLAYER_STATUSES.LOADING &&
                currentState.status !== PLAYER_STATUSES.IDLE &&
                currentState.status !== PLAYER_STATUSES.PAUSED &&
                currentState.status !== PLAYER_STATUSES.STOPPED

            if (this.sonosTrackId !== this.currentVideoId && this.sonosIsPlaying && ignoreStates) {
                this.logger.info(`[SonosPlayer]: Next was triggered by fallback, PANIC: Mismatched videoIds`)
                this.sonosCrossfade = true
                this.next()
            }

            if (currentState.position - 5 > currentState.duration && currentState.status !== -1) {
                this.logger.info(`[SonosPlayer]: Next was triggered by fallback`)
                this.next()
            }
        }, 5000)
    }

    /**
     * Synchronizes the local playback timer with Sonos player position.
     * This ensures our position tracking stays accurate with the actual Sonos playback.
     */
    protected async syncSeek(): Promise<boolean> {
        try {
            if (this.currentFileUrl !== '') {
                const response = await fetch(
                    `${this.ownIpServerEndpoint}/audio/${this.currentFileUrl.split('/').pop()}/info`,
                )
                const musicInfos = await response.json()
                const result = await this.sonos.AVTransportService.GetPositionInfo({
                    InstanceID: 0,
                })
                const realTime = timeStringToSeconds(result.RelTime)
                const localTimer = Math.floor(this.timer.ms() / 1000)

                this.duration = musicInfos.duration
                this.seekOffset = realTime - localTimer
            }
            super.notifyExternalStateChange()
        } catch (error) {
            this.logger.error(error)
        }
        return false
    }

    /**
     * Handles playback of a video through Sonos.
     * Converts YouTube video to audio and configures Sonos for playback.
     * Also handles preloading of next track for smooth transitions.
     */
    protected async doPlay(video: Video, position: number): Promise<boolean> {
        this.logger.info(`[SonosPlayer]: Play ${video.id} at position ${position}s`)
        return this.#sonosPlayer(video, position)
    }

    /**
     * Pauses playback on the Sonos device and local timer.
     */
    protected doPause(): Promise<boolean> {
        this.logger.info('[SonosPlayer]: Pause')
        return this.#sonosPause()
    }

    /**
     * Resumes playback on the Sonos device and local timer.
     */
    protected doResume(): Promise<boolean> {
        this.logger.info('[SonosPlayer]: Resume')
        return this.#sonosResume()
    }

    /**
     * Stops playback on the Sonos device and resets local state.
     */
    protected doStop(): Promise<boolean> {
        this.logger.info('[SonosPlayer]: Stop')
        return this.#sonosStop()
    }

    /**
     * Seeks to a specific position in the current track.
     * @param position Position in seconds to seek to
     */
    protected doSeek(position: number): Promise<boolean> {
        this.logger.info(`[SonosPlayer]: Seek to ${position}s`)
        return this.#sonosSeek(position)
    }

    /**
     * Sets the volume level on the Sonos device.
     * @param volume Volume settings to apply
     */
    protected async doSetVolume(volume: Volume): Promise<boolean> {
        try {
            await this.sonos.SetVolume(volume.level)
        } catch (error) {
            this.logger.error(`[SonosPlayer] Error`, error)
        }

        this.volume = volume
        return true
    }

    /**
     * Gets the current volume level from the Sonos device.
     */
    protected async doGetVolume(): Promise<Volume> {
        try {
            const { CurrentVolume } = await this.sonos.RenderingControlService.GetVolume({
                InstanceID: 0,
                Channel: 'Master',
            })
            this.volume.level = CurrentVolume
        } catch (error) {
            this.logger.error(`[SonosPlayer] Error`, error)
        }

        return this.volume
    }

    /**
     * Gets the current playback position by combining the seek offset with the timer.
     */
    protected doGetPosition(): Promise<number> {
        return Promise.resolve(this.seekOffset + Math.floor(this.timer.ms() / 1000))
    }

    /**
     * Gets the total duration of the current track in seconds.
     */
    protected doGetDuration(): Promise<number> {
        return Promise.resolve(this.duration)
    }

    /**
     * Resumes playback on the Sonos device and manages local timer state.
     * Handles timer resumption and timeout management.
     */
    async #sonosResume() {
        try {
            await this.sonos.Play()
        } catch (error) {
            this.logger.error(`[SonosPlayer] Error`, error)
        }

        if (this.timer.isPaused()) {
            this.timer.resume()
        } else if (this.timer.isStopped() || !this.timer.isStarted()) {
            this.timer.start()
        }
        this.#startTimeout(this.duration - this.seekOffset)
        return Promise.resolve(true)
    }

    /**
     * Creates metadata for Sonos track
     */
    #createTrackMetadata(videoId: string, trackUrl: string) {
        return {
            AlbumArtUri: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            Duration: secondsToTimeString(this.duration),
            ItemId: '-1',
            ParentId: '-1',
            TrackUri: trackUrl,
            UpnpClass: 'object.item.audioItem.musicTrack',
            ProtocolInfo: 'http-get:*:audio/mpeg',
        }
    }

    /**
     * Converts YouTube video ID to audio URL
     */
    async #getAudioUrl(videoId: string, noWait?: Boolean): Promise<string> {
        interface ConvertJob {
            url: string
            status: string
        }
        const response = await fetch(`${this.ownIpServerEndpoint}/convert?videoId=${videoId}&noWait=${!!noWait}`)
        const json = (await response.json()) as ConvertJob
        return json.url
    }

    /**
     * Core playback implementation for Sonos integration.
     * Handles:
     * - Video to audio conversion
     * - Queue management
     * - Metadata setting
     * - Next track preloading
     * - Crossfade handling
     */
    async #sonosPlayer(video: Video, position: number): Promise<boolean> {
        this.seekOffset = position
        this.timer.stop()
        this.#resetTimeout()
        const info = await this.videoLoader.getInfo(video)
        this.logger.debug(`[sonosPlayer] Video info for ${video.id}:`, info)

        if (info) {
            const duration = info.duration || 0
            this.currentVideoId = video.id
            this.currentVideoTitle = info.title
            this.timer.start()
            this.#startTimeout(duration - this.seekOffset)
            this.duration = Number(duration)
        }

        const currentUrl = await this.#getAudioUrl(video.id)
        this.currentFileUrl = currentUrl

        // Sonos integration logic
        try {
            const currentQueue = this.queue.getState()
            const previousSongId = currentQueue.previous?.id
            const currentSongId = video.id
            const nextSongId = currentQueue.next?.id

            if (currentSongId !== previousSongId && currentSongId !== this.sonosNextTrackTitle) {
                this.logger.info(`[sonosPlayer] Loading next music track in forced mode!`)
                await this.sonos.AVTransportService.RemoveAllTracksFromQueue()
                await this.sonos.AVTransportService.SetAVTransportURI({
                    InstanceID: 0,
                    CurrentURI: currentUrl,
                    CurrentURIMetaData: this.#createTrackMetadata(currentSongId, currentUrl),
                })

                if (nextSongId) {
                    this.logger.info(`[sonosPlayer] Preloading Video`, nextSongId)
                    const newTrackUrl = await this.#getAudioUrl(nextSongId, true)
                    await this.sonos.AVTransportService.SetNextAVTransportURI({
                        InstanceID: 0,
                        NextURI: newTrackUrl,
                        NextURIMetaData: this.#createTrackMetadata(nextSongId, newTrackUrl),
                    })
                }
            } else {
                this.logger.info(`[sonosPlayer] Loading next music track in fluide mode!`)
                if (nextSongId) {
                    this.logger.info(`[sonosPlayer] Preloading Video`, nextSongId)
                    this.#getAudioUrl(nextSongId, true).then(async (nextTrackUrl) => {
                        await this.sonos.AVTransportService.SetNextAVTransportURI({
                            InstanceID: 0,
                            NextURI: nextTrackUrl,
                            NextURIMetaData: this.#createTrackMetadata(nextSongId, nextTrackUrl),
                        })
                        this.logger.info(`[sonosPlayer] Added Track Async`)
                    })
                }

                if (!this.sonosCrossfade) {
                    await this.sonos.Next()
                    await this.sonos.Play()
                } else {
                    this.sonosCrossfade = false
                }

                return true
            }

            await this.sonos.Play()
            await new Promise<void>((resolve) => {
                this.sonosStateEmitter.once('PLAYING', () => {
                    return resolve()
                })
            })
            return true
        } catch (error) {
            this.logger.error(`[sonosPlayer] Error`, error)
        }
        return false
    }

    /**
     * Pauses playback on the Sonos device and manages local timer state.
     * Handles error cases during sound switching.
     */
    async #sonosPause() {
        try {
            await this.sonos.Pause()
        } catch (error) {
            this.logger.error(`[SonosPlayer] If this error appears while soundswitch then you can ignore it.`)
            this.logger.error(`[SonosPlayer] Error`, error)
        }

        this.timer.pause()
        this.#resetTimeout()
        return true
    }

    /**
     * Stops playback on the Sonos device and resets local state.
     * Handles crossfade scenarios differently to ensure smooth transitions.
     */
    async #sonosStop() {
        try {
            if (!this.sonosCrossfade) await this.sonos.Stop()
        } catch (error) {
            this.logger.error(`[SonosPlayer] Error`, error)
        }

        this.seekOffset = 0
        this.timer.stop().clear()
        this.#resetTimeout()
        return true
    }

    /**
     * Seeks to a specific position in the current track.
     * Updates local timer state and handles playback resumption if needed.
     * @param position Position in seconds to seek to
     */
    async #sonosSeek(position: number) {
        try {
            const seekTime = secondsToTimeString(position)
            const result = await this.sonos.SeekPosition(seekTime)
            console.log(result)
        } catch (error) {
            this.logger.error(`[SonosPlayer] Error`, error)
        }

        this.timer.stop().clear()
        this.seekOffset = position
        this.#resetTimeout()
        if (this.status === PLAYER_STATUSES.PLAYING) {
            return Promise.resolve(this.#sonosResume())
        }
        return Promise.resolve(true)
    }

    /**
     * Clears the current timeout if one exists.
     * Used to manage track end detection and cleanup.
     */
    #resetTimeout() {
        if (this.timeout) {
            clearTimeout(this.timeout)
            this.timeout = null
        }
    }

    /**
     * Starts a new timeout for track end detection.
     * When timeout triggers, stops the timer and prepares for next track.
     * @param duration Duration in seconds until track should end
     */
    #startTimeout(duration: number) {
        this.#resetTimeout()
        this.timeout = setTimeout(() => {
            void (async () => {
                this.timer.stop().clear()
                this.logger.info('[SonosPlayer] Playback ended. Moving to next in list...')
            })()
        }, (duration + 1) * 1000)
    }

    /**
     * Emits the current player state through the 'fakeState' event.
     * Includes current status, video info, position, duration, and volume.
     * Used to keep external components updated about player state changes.
     */
    #emitFakeState() {
        void (async () => {
            this.emit('fakeState', {
                status: this.status,
                videoId: this.currentVideoId,
                videoTitle: this.currentVideoTitle,
                duration: await this.getDuration(),
                position: await this.getPosition(),
                volume: await this.getVolume(),
            })
        })()
    }

    on(event: 'fakeState', listener: (data: SonosState) => void): this
    on(
        event: 'state',
        listener: (data: { AID: string; current: PlayerState; previous: PlayerState | null }) => void,
    ): this
    on(event: string | symbol, listener: (...args: any[]) => void): this {
        super.on(event, listener)
        return this
    }
}
