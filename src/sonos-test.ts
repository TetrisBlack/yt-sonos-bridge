import { SonosDevice } from '@svrooij/sonos/lib'

const sonos = new SonosDevice('')
sonos.LoadDeviceData()
// manager.InitializeFromDevice('').then(console.log).then(() => {
//     manager.Devices.forEach(d => {
//         return console.log('Device %s (%s) is joined in %s', d.Name, d.GroupName)
//     })
// }).catch((e: any) => {
//     console.error(e);
// });

sonos
    .LoadDeviceData()
    .then((success) => {
        console.log(sonos.Name)
    })
    .catch(console.error)

// sonos.PlayNotification({
//     trackUri: 'https://cdn.smartersoft-group.com/various/pull-bell-short.mp3', // Can be any uri sonos understands
//     // trackUri: 'https://cdn.smartersoft-group.com/various/someone-at-the-door.mp3', // Cached text-to-speech file.
//     onlyWhenPlaying: false, // make sure that it only plays when you're listening to music. So it won't play when you're sleeping.
//     timeout: 10, // If the events don't work (to see when it stops playing) or if you turned on a stream, it will revert back after this amount of seconds.
//     volume: 80, // Set the volume for the notification (and revert back afterwards)
//     delayMs: 700 // Pause between commands in ms, (when sonos fails to play sort notification sounds).
// })
//     .then(played => {
//         console.log('Played notification %o', played)
//     })

// const queue = await sonos.GetQueue()
// await sonos.QueueService.RemoveAllTracks({
//     QueueID: 0,
//     UpdateID: queue.UpdateID,
// });

// working mp3
// const result = await sonos.AVTransportService.SetAVTransportURI(
//     {
//         InstanceID: 0,
//         CurrentURI: 'https://cdn.smartersoft-group.com/various/pull-bell-short.mp3',
//         CurrentURIMetaData: {
//             Title: "Pull the bell",
//             Artist: "Various",
//             Album: "Various",
//             AlbumArtUri: "http:///getaa?s=1&u=x-sonosapi-hls-static%3aALkSOiEcVI2XbnW-uNc97fVFoObxZqNfFmhFqtP5XHq52k4RONMofz9TJBjVPt5CRUh8YkvT_Q%3fsid%3d284%26flags%3d8%26sn%3d2",
//             Duration: '01:37',
//             ItemId: "-1",
//             ParentId: "-1",
//             TrackUri: "https://cdn.smartersoft-group.com/various/pull-bell-short.mp3",
//             UpnpClass: "object.item.audioItem.musicTrack",
//             ProtocolInfo: "sonos.com-http:*:application/x-mpegURL:*"
//         },

//     }
// );

// first remove all tracks from queue
// await sonos.AVTransportService.RemoveAllTracksFromQueue()

interface ConvertJob {
    url: string
    status: string
}

// const streamUrl = await fetch('http:///convert?url=aHR0cHM6Ly9ycjItLS1zbi1oMGplZW5sNi5nb29nbGV2aWRlby5jb20vdmlkZW9wbGF5YmFjaz9leHBpcmU9MTc0MDA5NTE1NiZlaT1WR3EzWjRxUkktbkhpOW9QbWNuYmlBTSZpcD0xOTMuMTU5LjEzNy42MyZpZD1vLUFLQnl6blAtWlJuLTNWMkd0b29vQVR0ODR5ZEloWlVTYmhKN1hMeUEtczl5Jml0YWc9MTgmc291cmNlPXlvdXR1YmUmcmVxdWlyZXNzbD15ZXMmeHBjPUVnVm8yYURTTlElM0QlM0QmbWV0PTE3NDAwNzM1NTYlMkMmbWg9Q2QmbW09MzElMkMyOSZtbj1zbi1oMGplZW5sNiUyQ3NuLWgwamVsbjdlJm1zPWF1JTJDcmR1Jm12PW0mbXZpPTImcGw9MjYmcm1zPWF1JTJDYXUmY3RpZXI9QSZwZmE9NSZnY3I9ZGUmaW5pdGN3bmRicHM9MjYzNzUwMCZoaWdodGM9eWVzJnNpdT0xJmJ1aT1BVVdETDN5X3lrUEZGMDdybEUwdXdxYzZWRkJzOTROeFVCTjRMX2h5dE0yZUd2eHhuRE9kZURTU21LYnVOTENWNHh1bjYyallCQSZzcGM9UmpaYlNmSmp3NkxUeG1sVkhZa3JFbVlkMkgwSlNSZ0Nwb2pTTnB6STFzckxMYmd5Z2hjeWM1V28wX3VISG9UdUsyNHl1bUtNd3RlSmxfbyZ2cHJ2PTEmc3ZwdWM9MSZtaW1lPXZpZGVvJTJGbXA0Jm5zPWZWYmIzR2NJa1lXclBzdy1KTFNmSzJVUSZycWg9MSZnaXI9eWVzJmNsZW49NTMwOTA2MSZyYXRlYnlwYXNzPXllcyZkdXI9MjU3LjgzNCZsbXQ9MTY5ODYwMDU1NjI3MzkzMiZtdD0xNzQwMDczMDIwJmZ2aXA9NSZmZXhwPTUxMzI2OTMyJmM9V0VCX1JFTUlYJnNlZmM9MSZ0eHA9MjMxOTIyNCZuPWtLTzRsbHA0SjlmNzZ3JnNwYXJhbXM9ZXhwaXJlJTJDZWklMkNpcCUyQ2lkJTJDaXRhZyUyQ3NvdXJjZSUyQ3JlcXVpcmVzc2wlMkN4cGMlMkNjdGllciUyQ3BmYSUyQ2djciUyQ2hpZ2h0YyUyQ3NpdSUyQ2J1aSUyQ3NwYyUyQ3ZwcnYlMkNzdnB1YyUyQ21pbWUlMkNucyUyQ3JxaCUyQ2dpciUyQ2NsZW4lMkNyYXRlYnlwYXNzJTJDZHVyJTJDbG10JmxzcGFyYW1zPW1ldCUyQ21oJTJDbW0lMkNtbiUyQ21zJTJDbXYlMkNtdmklMkNwbCUyQ3JtcyUyQ2luaXRjd25kYnBzJmxzaWc9QUdsdUozTXdSQUlnVUFzQzJTaDQ2WWxvSng4bmt5VWNCNkhiX1dRYzdMYlg2UGNLSVlfM1IwMENJRERoMXJYb2toQTNsQW44dlVXbVQ4eVFucVVraTJvbklxTmdseVpET0wzYSZzaWc9QUpmUWRTc3dSQUlnYmF5VWczblRWdHhMS2M2VVlCeFl0dUlLRUtQVlNKNHBtOVBfTVFiR29pZ0NJRGJObGtOTHd4WWtROHNCOGdTcWFkQUxNekQwQ0xWMkZfTzNGd2szQ0NsNyZjdmVyPTEuMjAyMTEyMTMuMDAuMDA=')
// const json = await streamUrl.json() as ConvertJob

// // base64 live converted mp4 to mp3 stream
// const result = await sonos.AVTransportService.SetAVTransportURI(
//     {
//         InstanceID: 0,
//         CurrentURI: json.url,
//         CurrentURIMetaData: {
//             Title: "Pull the bell",
//             Artist: "Various",
//             Album: "Various",
//             AlbumArtUri: "http:///getaa?s=1&u=x-sonosapi-hls-static%3aALkSOiEcVI2XbnW-uNc97fVFoObxZqNfFmhFqtP5XHq52k4RONMofz9TJBjVPt5CRUh8YkvT_Q%3fsid%3d284%26flags%3d8%26sn%3d2",
//             Duration: '01:37',
//             ItemId: "-1",
//             ParentId: "-1",
//             TrackUri: json.url,
//             UpnpClass: "object.item.audioItem.musicTrack",
//             ProtocolInfo: "sonos.com-http:*:application/x-mpegURL:*"
//         },
//     }
// );

// await sonos.Play()

// await sonos.AVTransportService.AddURIToQueue(
//     {
//         InstanceID: 0,
//         EnqueuedURI: 'https://cdn.smartersoft-group.com/various/pull-bell-short.mp3',
//         EnqueuedURIMetaData: {
//             Title: "Pull the bell",
//         },
//         DesiredFirstTrackNumberEnqueued: 0,
//         EnqueueAsNext: true
//     }).catch((e) => {
//         console.error(e);
//     }).then(msg => {
//         console.log(msg);
//     })

// await sonos.TogglePlayback()

// await sonos.SetAVTransportURI('http:///stream?videoId=hUgzsTacibs')
// const result = await sonos.AVTransportService.SetAVTransportURI(
//     {
//         InstanceID: 0,
//         CurrentURI: 'http:///stream?videoId=hUgzsTacibs',
//         CurrentURIMetaData: {
//             Title: "Pull the bell",
//             Artist: "Various",
//             Album: "Various",
//             AlbumArtUri: "http:///getaa?s=1&u=x-sonosapi-hls-static%3aALkSOiEcVI2XbnW-uNc97fVFoObxZqNfFmhFqtP5XHq52k4RONMofz9TJBjVPt5CRUh8YkvT_Q%3fsid%3d284%26flags%3d8%26sn%3d2",
//             Duration: '01:37',
//             ItemId: "-1",
//             ParentId: "-1",
//             TrackUri: 'http:///stream?videoId=hUgzsTacibs',
//             UpnpClass: "object.item.audioItem.musicTrack",
//             ProtocolInfo: "sonos.com-http:*:application/x-mpegURL:*"
//         },
//     }
// );
await sonos.AVTransportService.GetPositionInfo()
    .then((response) => {
        console.log(JSON.stringify(response, null, 2))
    })
    .catch((err) => console.error(err))

await sonos.Play().catch((err) => {
    console.log('Sonos error', err)
})

//await sonos.Next()
