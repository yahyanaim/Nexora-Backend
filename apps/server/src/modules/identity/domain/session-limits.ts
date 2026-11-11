/**
 * Session limits per realm (cahier Table 6, decisions B1 and D3; IAM-07). A
 * session ends at whichever comes first: its idle limit after the last
 * activity, or its absolute limit after it was created. Pure.
 */

export const REALMS = ["member", "portal", "staff"] as const
export type Realm = (typeof REALMS)[number]

export interface RealmLimits {
  idleMinutes: number
  absoluteHours: number
}

export const SESSION_LIMITS: Readonly<Record<Realm, RealmLimits>> = Object.freeze({
  member: { idleMinutes: 30, absoluteHours: 12 },
  portal: { idleMinutes: 120, absoluteHours: 7 * 24 },
  staff: { idleMinutes: 15, absoluteHours: 8 },
})

/** The access cookie lives 15 minutes; a refresh rotates it (§8.2). */
export const ACCESS_TOKEN_MINUTES = 15

export interface SessionTimes {
  createdAt: Date
  lastActivityAt: Date
}

/** When the session ends if nothing happens: the earlier of its idle and absolute limits. */
export function sessionEndsAt(realm: Realm, times: SessionTimes, limits: RealmLimits = SESSION_LIMITS[realm]): Date {
  const idle = times.lastActivityAt.getTime() + limits.idleMinutes * 60_000
  const absolute = times.createdAt.getTime() + limits.absoluteHours * 3_600_000
  return new Date(Math.min(idle, absolute))
}

export function isSessionExpired(realm: Realm, times: SessionTimes, now: Date, limits?: RealmLimits): boolean {
  return now.getTime() >= sessionEndsAt(realm, times, limits).getTime()
}

/**
 * A workspace may shorten the member limits (§8.2 rule 3), never lengthen them.
 * Values that are not positive whole numbers are ignored.
 */
export function memberLimits(override?: Partial<RealmLimits>): RealmLimits {
  const base = SESSION_LIMITS.member
  const pick = (value: number | undefined, max: number) => (value !== undefined && Number.isInteger(value) && value > 0 ? Math.min(value, max) : max)
  return { idleMinutes: pick(override?.idleMinutes, base.idleMinutes), absoluteHours: pick(override?.absoluteHours, base.absoluteHours) }
}
