// Sleeper Towns — the whole model in one place.
//
// Per place and destination we know two queried numbers (minutes, weekday morning):
// car = Google traffic-aware drive time (null for car-free places like Zermatt),
// pt  = SBB timetable door-to-door time (null if there is no connection).
//
//   today    = min(car, pt)          best option today
//   av       = car / comfort         effective time in a self-driving car
//   tomorrow = min(pt, av)           best option once the car drives itself
//
// The autonomous car is always compared against today's best option, never against
// driving yourself. Against the commute threshold T a place is
//
//   TODAY  today ≤ T                     commutable already
//   FLIP   today > T and tomorrow ≤ T    becomes commutable ("kippt")
//   FAR    tomorrow > T                  stays out of range

export const DEFAULTS = { dest: 'zurich', threshold: 45, comfort: 1.5, av: true }

// [min, max, step] for the sliders
export const LIMITS = { threshold: [15, 90, 5], comfort: [1, 2.5, 0.1] }

export const TODAY = 1
export const FLIP = 2
export const FAR = 3

const minOf = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b))

export function evaluate(car, pt, { threshold, comfort }) {
  const today = minOf(car, pt)
  // Whole minutes like the source data, so displayed and classified values agree
  const av = car == null ? null : Math.round(car / comfort)
  const tomorrow = minOf(pt, av)
  const cat = today <= threshold ? TODAY : tomorrow <= threshold ? FLIP : FAR
  return {
    car,
    pt,
    today,
    todayMode: car == null || (pt != null && pt < car) ? 'pt' : 'car',
    av,
    tomorrow,
    tomorrowMode: av == null || (pt != null && pt <= av) ? 'pt' : 'av',
    cat,
  }
}

/**
 * Evaluate every place against one destination.
 * car, pt: minutes from place i to the destination (null = no such option).
 * Returns per-place results (null where neither mode exists), category counts and
 * the flipped places, largest settlements first.
 */
export function computeResults(places, car, pt, settings) {
  const rows = new Array(places.length).fill(null)
  const stats = { [TODAY]: 0, [FLIP]: 0, [FAR]: 0 }
  const flips = []
  places.forEach((p, i) => {
    if (car[i] == null && pt[i] == null) return
    const r = evaluate(car[i], pt[i], settings)
    rows[i] = r
    stats[r.cat]++
    if (r.cat === FLIP) flips.push(p)
  })
  flips.sort((a, b) => b.pc - a.pc || rows[a.id].today - rows[b.id].today || a.n.localeCompare(b.n, 'de'))
  return { rows, stats, flips }
}
