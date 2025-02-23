import YouTubeCastReceiver, {
    type Player,
    type Logger,
    type PairingCodeRequestService,
    LOG_LEVELS,
    RESET_PLAYER_ON_DISCONNECT_POLICIES,
} from 'yt-cast-receiver'
import { type PlaylistEvent } from 'yt-cast-receiver'
import SonosPlayer from './SonosPlayer'
import { SonosDevice } from '@svrooij/sonos/lib'
import './mp4-to-mp3-server'

const playerName = process.env.PLAYER_NAME || 'Youtube Sonos Bridge'
const playerBrand = process.env.PLAYER_BRAND || 'Not a real device'
const logLevelString = process.env.LOG_LEVEL || 'info'
const sonosDeviceIp = process.env.SONOS_DEVICE_IP
let ownIpServerEndpoint = process.env.SERVER_ENDPOINT

if (sonosDeviceIp === undefined || ownIpServerEndpoint === undefined) {
    console.error('SONOS_DEVICE_IP not set')
    process.exit(1)
}

const logLevel = LOG_LEVELS[logLevelString as keyof typeof LOG_LEVELS]
class SonosPlayerReceiver {
    #player: Player
    #logger: Logger
    #receiver: YouTubeCastReceiver
    #pairingCodeRequestService: PairingCodeRequestService

    constructor() {
        // Create an sonos device
        const sonosDevice = new SonosDevice(sonosDeviceIp as string)

        // Create our own player instance
        const player = (this.#player = new SonosPlayer(sonosDevice, ownIpServerEndpoint as string))

        // Create `YouTubeCastReceiver` instance, specifying our own player implementation.
        const receiver = (this.#receiver = new YouTubeCastReceiver(player, {
            dial: { port: 8099 }, // DIAL server port
            app: { resetPlayerOnDisconnectPolicy: RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_EXPLICITLY_DISCONNECTED },
            logLevel: logLevel, // Ouput debug messages
            dataStore: false,
            device: {
                brand: playerBrand,
                name: playerName,
            },
        }))

        // `DefaultLogger` if UI disabled; otherwise this will be our custom `screenLogger`
        this.#logger = receiver.logger

        // Listen to player queue events
        const queueEventListener = this.#handleQueueEvent.bind(this)
        player.queue.on('playlistAdded', queueEventListener)
        player.queue.on('playlistCleared', queueEventListener)
        player.queue.on('playlistSet', queueEventListener)
        player.queue.on('videoAdded', queueEventListener)
        player.queue.on('videoRemoved', queueEventListener)
        player.queue.on('videoSelected', queueEventListener)

        // Listen to `YouTubeCastReceiver` events.
        receiver.on('senderConnect', (sender) => {
            const nameParts = [] as string[]
            if (sender.user?.name) {
                nameParts.push(sender.user.name)
            }
            if (sender.client?.name) {
                nameParts.push(sender.client.name)
            }
            const nameStr = sender.name + (nameParts.length > 0 ? ` (${nameParts.join(' - ')})` : '')

            const totalConnectedSenders = receiver.getConnectedSenders().length

            const log = `Connected to ${nameStr}. Total connected senders: ${receiver.getConnectedSenders().length}`

            // clean up running tracks on sonos device
            if (totalConnectedSenders === 1) {
                sonosDevice.AVTransportService.RemoveAllTracksFromQueue()
            }

            this.#logger.info(log)
        })
        receiver.on('senderDisconnect', (sender, implicit) => {
            const log = `Disconnected from ${sender.name} (${sender.client?.name}${
                implicit ? ' - implicit' : ''
            }). Remaining connected senders: ${receiver.getConnectedSenders().length}`
            if (screen) {
            } else {
                this.#logger.info(log)
            }
        })
        receiver.on('error', (error: any) => {
            this.#logger.error('[SonosPlayer] Error occurred:', error)
        })
        // The `terminate` event essentially means `YouTubeCastReceiver` has crashed with error.
        // Note that `error` in this case gets emitted once and only once in the `terminate` event.
        receiver.on('terminate', (error: any) => {
            this.#logger.error('!!!! YouTubeCastReceiver has crashed !!! Reason:', error)
        })

        // Service for fetching pairing code for manual pairing (aka Link with TV code)
        this.#pairingCodeRequestService = receiver.getPairingCodeRequestService()
    }

    #handleQueueEvent(event: PlaylistEvent) {
        let msg: string | null = '[SonosPlayer] '
        const videoCount = event.videoIds ? event.videoIds.length : event.videoId ? 1 : 0
        const byUser = event.user ? ` by ${event.user.name}` : null
        switch (event.type) {
            case 'playlistAdded':
                if (videoCount > 0) {
                    msg += `Playlist with ${videoCount} videos added to queue`
                } else {
                    msg = 'Playlist added to queue'
                }
                break
            case 'playlistCleared':
                msg += 'Queue cleared'
                break
            case 'playlistSet':
                if (videoCount > 0) {
                    msg += `Playlist with ${videoCount} videos set as queue`
                } else {
                    msg = 'Playlist set as queue'
                }
                break
            case 'videoAdded':
                if (event.videoId) {
                    msg += `Video ${event.videoId} added to queue`
                } else {
                    msg += 'Video added to queue'
                }
                break
            case 'videoRemoved':
                if (event.videoId) {
                    msg += `Video ${event.videoId} removed from queue`
                } else {
                    msg += 'Video removed from queue'
                }
                break
            case 'videoSelected':
                if (event.videoId) {
                    msg += `Video ${event.videoId} selected`
                } else {
                    msg += 'Video selected'
                }
                break
            default:
                msg = null
        }
        if (msg && byUser) {
            msg += byUser
        }
        if (msg) {
            this.#logger.info(`${msg}.`)
        }
    }

    async start() {
        try {
            // Start `YouTubeCastReceiver` instance
            await this.#receiver.start()
        } catch (error) {
            // Catch errors to prevent application from crashing right back into the console
            this.#logger.error('[SonosPlayer] Error occurred while starting receiver:', error)
            return
        }
        this.#logger.info('[SonosPlayer] YouTubeCastReceiver started.')

        // Start service to obtain manual pairing code and listen to events.
        this.#pairingCodeRequestService.on('request', () => {
            // `request` event: request is being made
            this.#logger.debug('[SonosPlayer] Obtaining code for manual pairing...')
        })
        this.#pairingCodeRequestService.on('response', (code: any) => {
            // `response` event: pairing code obtained
            this.#logger.info(`[SonosPlayer] Code for manual pairing (aka Link with TV code): ${code}`)
        })
        this.#pairingCodeRequestService.on('error', (error: any) => {
            // Service automatically stops on `error` event
            this.#logger.error('[SonosPlayer] Error occurred while obtaining code for manual pairing:', error)
        })
        this.#pairingCodeRequestService.start()
    }

    async stop() {
        try {
            // Stop `YouTubeCastReceiver` instance
            await this.#receiver.stop()
        } catch (error) {
            // Again, like `start()`, we catch errors to prevent application from crashing back into console.
            this.#logger.error('[SonosPlayer] Error occurred while stopping receiver:', error)
            return
        }

        this.#pairingCodeRequestService.removeAllListeners()
        this.#pairingCodeRequestService.stop()
        this.#logger.info('[SonosPlayer] YouTubeCastReceiver stopped.')
    }

    async exit() {
        try {
            await this.stop()
        } catch (_error: unknown) {
            this.#logger.warn('[SonosPlayer] Error occurred while stopping receiver. Exiting uncleanly...')
        }
        this.#logger.info('[SonosPlayer] Bye!')
        process.exit(0)
    }
}

const sonosPlayerReceiver = new SonosPlayerReceiver()
void sonosPlayerReceiver.start()
