/**
 * The sync engine's network seam. Everything the engine sends goes through a
 * Transport - a fetch-shaped function - so tests drive the whole protocol
 * without a network and the Supabase REST layer stays a thin adapter.
 */

export type Transport = (url: string, options?: RequestInit) => Promise<Response>

/** The real thing: the browser's fetch. */
export const defaultTransport: Transport = (url, options) => fetch(url, options)
