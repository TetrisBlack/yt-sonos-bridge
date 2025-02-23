/**
 * Converts seconds to a time string in "H:MM:SS" format
 * @param seconds The number of seconds to convert
 * @returns A string in "H:MM:SS" format
 */
export function secondsToTimeString(seconds: number): string {
    // Handle invalid input
    if (isNaN(seconds) || seconds < 0) {
        return '0:00:00'
    }

    // Round to nearest integer
    const totalSeconds = Math.round(seconds)

    // Calculate hours, minutes, and remaining seconds
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const remainingSeconds = totalSeconds % 60

    // Format with leading zeros
    const minutesStr = minutes.toString().padStart(2, '0')
    const secondsStr = remainingSeconds.toString().padStart(2, '0')

    return `${hours}:${minutesStr}:${secondsStr}`
}

/**
 * Converts a time string in "H:MM:SS" format to seconds
 * @param timeString The time string to convert (format: "H:MM:SS")
 * @returns The number of seconds, or 0 if the input is invalid
 */
export function timeStringToSeconds(timeString: string): number {
    // Check if the string matches the expected format
    const match = timeString.match(/^(\d+):([0-5]\d):([0-5]\d)$/)
    if (!match) {
        return 0
    }

    // Extract hours, minutes, and seconds
    const [, hoursStr, minutesStr, secondsStr] = match
    const hours = parseInt(hoursStr, 10)
    const minutes = parseInt(minutesStr, 10)
    const seconds = parseInt(secondsStr, 10)

    // Convert to total seconds
    return hours * 3600 + minutes * 60 + seconds
}
