export function getIdFromUrl(url: string): string {
    return url.split('/').pop()?.replace('.mp3', '') ?? ''
}
