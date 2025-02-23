# Sonos YouTube Bridge

A Node.js bridge that enables YouTube video casting to Sonos devices. This project creates a receiver that allows you to cast YouTube content to your Sonos system, with support for queue management and playback control.

## Features

-   YouTube casting support via DIAL protocol
-   Queue management for videos and playlists
-   Manual pairing with TV code
-   MP4 to MP3 conversion for audio playback
-   Custom device name and branding
-   Detailed logging system
-   Docker support for easy deployment

## Prerequisites

-   Node.js (Latest LTS version recommended)
-   FFmpeg (for MP4 to MP3 conversion)
-   Docker (optional, for containerized deployment)

## Installation

Docker is the recommended way to deploy this application as it handles all dependencies and provides the most reliable setup.

### Docker Installation (Recommended)

1. Clone the repository and navigate to the docker directory:

```bash
git clone [repository-url]
cd sonos-bullshit-bridge
```

2. Build and run using Docker Compose:

```bash
docker compose -f docker/compose.yml up -d
```

### Manual Installation

Only use this method if you cannot use Docker for some reason.

1. Clone the repository:

```bash
git clone [repository-url]
cd sonos-bullshit-bridge
```

2. Install dependencies:

```bash
npm install
```

## Configuration

The bridge can be configured using environment variables:

| Variable        | Description                              | Default                 |
| --------------- | ---------------------------------------- | ----------------------- |
| SONOS_DEVICE_IP | IP address of your Sonos device          | Required                |
| SERVER_ENDPOINT | Server endpoint for Docker deployment    | Required                |
| LOG_LEVEL       | Logging level (debug, info, warn, error) | info                    |
| YT_PLAYER_BRAND | Custom brand name for the device         | Coffee drunk solutions  |
| YT_PLAYER_NAME  | Custom name for the device               | Don't be a bitch sonos! |

Create a `.env` file in the root directory with your configuration.

## Usage

### Running with Docker (Recommended)

```bash
docker compose -f docker/compose.yml up -d
```

The bridge will appear in your YouTube casting devices list with your configured custom name.

### Running Locally (Development Only)

Only use this method for development purposes:

Development mode with auto-reload:

```bash
npm run dev
```

Production mode:

```bash
npm run build
npm run prod
```

## Development

Available npm scripts:

```bash
npm run dev      # Run in development mode with auto-reload
npm run build    # Build the project using pkgroll
npm run bundle   # Create a minified bundle
npm run prod     # Run the bundled version
```

## Technical Details

The bridge utilizes several key components:

-   `yt-cast-receiver`: Handles YouTube casting protocol
-   `@svrooij/sonos`: Sonos device integration
-   `fluent-ffmpeg`: Media format conversion
-   `hono`: HTTP server functionality
-   `sharp`: Image processing
-   `patch-package`: Dependency patching

### Network Requirements

-   DIAL server runs on port 8099
-   Requires network visibility between:
    -   YouTube casting device and the bridge
    -   Bridge and Sonos device
    -   Bridge and YouTube servers

### Dependencies

Core dependencies:

-   @distube/ytdl-core: ^4.16.4
-   @hono/node-server: ^1.13.8
-   @svrooij/sonos: ^2.6.0-beta.11
-   fluent-ffmpeg: ^2.1.3
-   hono: ^4.7.2
-   yt-cast-receiver: ^1.3.1
-   sharp: ^0.33.5

## Acknowledgements

This project wouldn't be possible without these excellent open source projects:

-   [`@svrooij/sonos`](https://github.com/svrooij/node-sonos-ts) - A powerful TypeScript library for controlling Sonos devices
-   [`yt-cast-receiver`](https://github.com/patrickkfkan/yt-cast-receiver) - A Node.js implementation of the YouTube Cast Receiver protocol

Special thanks to:

-   [Anthropic](https://www.anthropic.com)'s Claude 3.5 Sonnet - AI assistance for development and documentation
-   [Cline](https://github.com/cline/cline) - VSCode plugin for Claude integration

## License

This project is licensed under Apache 2.0. Note that it includes `peer-dial` (via `yt-cast-receiver`) which is licensed under LGPL-3.0.

## Support the Project

<a href="https://www.buymeacoffee.com/tetrisblack" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
