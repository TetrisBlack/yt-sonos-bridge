export function getIdFromUrl(url: string): string {
    try {
        return url.split('/').pop()?.replace('.mp3', '') ?? ''
    } catch (err) {
        return ''
    }
}
