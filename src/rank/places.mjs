// Reading a job posting's location string.
//
// The operator lists only the places they accept. Everything else is huntley's
// job: knowing that "Toronto" is abroad, that "Portland, ME" is not Portland,
// Oregon, that "Rochester, New York" is not New York City, and that a bare
// "Cupertino" is in California. That knowledge lives here, as data, so nobody
// has to maintain a list of every place they do NOT want.
//
// A location string is split into segments ("San Francisco, CA · London · Remote"
// is three), each segment into comma-separated parts, and each part is read as a
// city, a US state, a country, a region, or a remote marker.

// ── Reference data ──────────────────────────────────────────────────

const US_STATES = [
  ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'], ['california', 'ca'],
  ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'], ['district of columbia', 'dc'],
  ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'], ['idaho', 'id'], ['illinois', 'il'],
  ['indiana', 'in'], ['iowa', 'ia'], ['kansas', 'ks'], ['kentucky', 'ky'], ['louisiana', 'la'],
  ['maine', 'me'], ['maryland', 'md'], ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'],
  ['mississippi', 'ms'], ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'], ['nevada', 'nv'],
  ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'], ['new york', 'ny'],
  ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'], ['oklahoma', 'ok'], ['oregon', 'or'],
  ['pennsylvania', 'pa'], ['rhode island', 'ri'], ['south carolina', 'sc'], ['south dakota', 'sd'],
  ['tennessee', 'tn'], ['texas', 'tx'], ['utah', 'ut'], ['vermont', 'vt'], ['virginia', 'va'],
  ['washington', 'wa'], ['west virginia', 'wv'], ['wisconsin', 'wi'], ['wyoming', 'wy'],
];
const STATE_BY_NAME = new Map(US_STATES.map(([name, code]) => [name, code]));
const STATE_CODES = new Set(US_STATES.map(([, code]) => code));

const US_COUNTRY = new Set(['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america']);

// Cities and regions that boards often give with no state. Only needed to infer
// the state of a bare name; a city with an explicit state never consults this.
const US_CITIES = Object.fromEntries(`
ca: los angeles, la, san francisco, sf, san diego, san jose, oakland, berkeley, palo alto, mountain view,
    sunnyvale, santa clara, cupertino, menlo park, redwood city, san mateo, south san francisco, foster city,
    burlingame, san carlos, emeryville, fremont, milpitas, los gatos, campbell, san bruno, irvine, costa mesa,
    newport beach, long beach, santa monica, culver city, el segundo, hawthorne, torrance, pasadena, burbank,
    marina del rey, playa vista, sacramento, carlsbad, santa barbara, goleta, walnut creek, pleasanton,
    livermore, san ramon, bay area, san francisco bay area, silicon valley, socal, southern california,
    northern california
ny: new york, new york city, nyc, manhattan, brooklyn, queens, bronx, staten island, long island city, astoria
tx: austin, dallas, houston, san antonio, plano, irving, fort worth
wa: seattle, bellevue, redmond, kirkland, tacoma
or: portland, beaverton, hillsboro
il: chicago, evanston
ma: boston, somerville, waltham, burlington
co: denver, boulder
dc: washington dc, washington d c
ga: atlanta
pa: pittsburgh, philadelphia
mi: detroit, ann arbor
mn: minneapolis
ut: salt lake city
az: phoenix, tempe, scottsdale
nv: las vegas
tn: nashville
nc: raleigh, durham, charlotte
fl: miami, tampa, orlando
`.trim().split(/\n(?=[a-z]{2}:)/).flatMap((line) => {
  // A state's cities may wrap onto indented lines; only a `xx:` starts a new state.
  const [code, names] = line.split(':');
  return names.split(',').map((n) => [n.trim(), code.trim()]).filter(([n]) => n);
}));

// A city whose name stands for more than one place name. "NYC" in an allow-list
// means the whole city: every borough, and the neighbourhoods boards use as if
// they were cities.
const CITY_GROUPS = [
  ['new york', 'new york city', 'nyc', 'manhattan', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island',
    'long island city', 'astoria'],
];
const groupOf = (city) => CITY_GROUPS.find((g) => g.includes(city)) ?? null;

const FOREIGN_COUNTRIES = new Set(`
afghanistan albania algeria andorra angola argentina armenia australia austria azerbaijan bahamas bahrain
bangladesh barbados belarus belgium belize benin bhutan bolivia bosnia botswana brazil brunei bulgaria
cambodia cameroon canada chile china colombia congo costa rica croatia cuba cyprus czechia czech republic
denmark dominican republic ecuador egypt el salvador estonia ethiopia fiji finland france gabon gambia
germany ghana greece guatemala guinea guyana haiti honduras hong kong hungary iceland india indonesia iran
iraq ireland israel italy jamaica japan jordan kazakhstan kenya korea south korea kosovo kuwait kyrgyzstan
laos latvia lebanon lesotho liberia libya liechtenstein lithuania luxembourg macau madagascar malawi malaysia
maldives mali malta mauritius mexico moldova monaco mongolia montenegro morocco mozambique myanmar namibia
nepal netherlands new zealand nicaragua niger nigeria north macedonia norway oman pakistan panama paraguay
peru philippines poland portugal qatar romania russia rwanda saudi arabia senegal serbia singapore slovakia
slovenia south africa spain sri lanka sudan sweden switzerland syria taiwan tajikistan tanzania thailand togo
tunisia turkey turkiye uganda ukraine united arab emirates uae united kingdom uk great britain britain
england scotland wales northern ireland uruguay uzbekistan venezuela vietnam yemen zambia zimbabwe
`.trim().split(/\s{2,}|\n/).join(' ').match(/czech republic|costa rica|dominican republic|el salvador|hong kong|south korea|new zealand|north macedonia|saudi arabia|south africa|sri lanka|united arab emirates|united kingdom|great britain|northern ireland|[a-z]+/g));

const FOREIGN_REGIONS = new Set(['europe', 'european union', 'eu', 'emea', 'apac', 'asia', 'asia pacific',
  'latam', 'latin america', 'africa', 'middle east', 'oceania', 'nordics', 'dach', 'benelux', 'anz', 'mena']);

const CANADIAN_PROVINCES = new Set(['alberta', 'ab', 'british columbia', 'bc', 'manitoba', 'mb', 'new brunswick',
  'nb', 'newfoundland', 'nl', 'nova scotia', 'ns', 'ontario', 'on', 'quebec', 'qc', 'saskatchewan', 'sk']);

const CANADIAN_CITIES = new Set(['toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton', 'waterloo',
  'kitchener', 'winnipeg', 'halifax', 'mississauga', 'quebec city']);

// Tech hubs that boards name without their country.
const FOREIGN_CITIES = new Set([...CANADIAN_CITIES, 'london', 'manchester', 'edinburgh', 'dublin', 'paris',
  'berlin', 'munich', 'hamburg', 'amsterdam', 'zurich', 'geneva', 'stockholm', 'copenhagen', 'oslo', 'helsinki',
  'madrid', 'barcelona', 'lisbon', 'milan', 'rome', 'warsaw', 'krakow', 'prague', 'vienna', 'brussels',
  'tallinn', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'chennai', 'delhi', 'new delhi',
  'gurgaon', 'gurugram', 'noida', 'tel aviv', 'tokyo', 'seoul', 'beijing', 'shanghai', 'shenzhen', 'taipei',
  'hsinchu', 'sydney', 'melbourne', 'auckland', 'sao paulo', 'mexico city', 'buenos aires', 'bogota',
  'dubai', 'abu dhabi', 'riyadh', 'cairo', 'lagos', 'nairobi', 'cape town', 'johannesburg']);

const REMOTE = /\b(remote\w*|anywhere|work from home|wfh|distributed|fully distributed)\b/;
const PLACEHOLDER = /^(n\/?a|tbd|tba|none|unknown|various|-+)$/i;

// ── Normalisation ──────────────────────────────────────────────────

/** Lowercase, fold accents, keep letters/digits/commas, collapse the rest to spaces. */
function fold(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, ' ').replace(/[^a-z0-9,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Word-level containment: does `hay` contain the words of `needle` as a run? */
function containsWords(hay, needle) {
  if (!needle) return false;
  return (` ${hay} `).includes(` ${needle} `);
}

function stripSuffixes(part) {
  return part
    .replace(/\b(greater|metropolitan area|metro area|metro|area)\b/g, (m) => (m === 'area' ? 'area' : ''))
    .replace(/\s+/g, ' ').trim();
}

// ── Parsing ────────────────────────────────────────────────────────

/**
 * Split a location string into segments. Separators are the characters boards
 * use between alternatives; a work-mode note in brackets ("Boston (Onsite),
 * New York") also ends a segment, because the comma after it separates two
 * places rather than a city from its state.
 */
export function segments(location) {
  const raw = String(location ?? '')
    .replace(/\((?:on-?site|hybrid|in[- ]?office|in[- ]person)\)\s*,?/gi, ' ; ')
    .replace(/\(remote\)/gi, ' remote ');
  return raw.split(/\s*(?:[·•|;\/\n]|\s&\s|\sand\s|\sor\s)\s*/i).map((s) => s.trim()).filter(Boolean);
}

/**
 * Read one segment into the places it names.
 *
 * A segment can hold several places with no separator but commas —
 * "San Francisco, CA, USA, New York, NY, USA" — so parts are grouped into
 * places as they are read: a city that arrives after the current place already
 * has a state or a country starts the next place.
 *
 * @returns {{remote: boolean, places: object[]}}
 */
export function readSegment(segment) {
  const remote = REMOTE.test(fold(segment));
  const parts = segment.split(',')
    .map((p) => stripSuffixes(fold(p))
      .replace(/\b\d{5}(?: \d{4})?\b/g, '')        // ZIP codes
      .replace(REMOTE, '')
      .replace(/\b(hybrid|onsite|on site|in office|any office|office)\b/g, '')
      .replace(/\s+/g, ' ').trim())
    .filter((p) => p && !/^\d/.test(p));           // street addresses start with a number

  const places = [];
  let cur = null;
  const fresh = () => ({ city: null, state: null, us: false, foreign: false, foreignCity: false, inferredState: null, parts: [] });
  const next = () => { if (cur && cur.parts.length) places.push(cur); cur = fresh(); };
  next();

  for (const p of parts) {
    const prev = cur.parts.at(-1);
    const isStateName = STATE_BY_NAME.has(p) && !(cur.parts.length === 0 && US_CITIES[p]);
    const isStateCode = cur.parts.length > 0 && STATE_CODES.has(p);

    if (isStateName || isStateCode) {
      if (cur.state) next();
      // "CA" after a Canadian city or province is Canada, not California.
      if (p === 'ca' && (CANADIAN_CITIES.has(prev) || CANADIAN_PROVINCES.has(prev))) { cur.foreign = true; cur.parts.push(p); continue; }
      cur.state = isStateName ? STATE_BY_NAME.get(p) : p;
      cur.us = true; cur.parts.push(p); continue;
    }
    if (US_COUNTRY.has(p)) { cur.us = true; cur.parts.push(p); next(); continue; }
    if (cur.parts.length > 0 && CANADIAN_PROVINCES.has(p)) { cur.foreign = true; cur.parts.push(p); continue; }
    if (FOREIGN_COUNTRIES.has(p) || FOREIGN_REGIONS.has(p)
      || [...FOREIGN_COUNTRIES].some((c) => c.includes(' ') && containsWords(p, c))) {
      cur.foreign = true; cur.parts.push(p); next(); continue;
    }

    // Anything else is a city, or a phrase containing one.
    if (cur.city || cur.state) next();
    cur.city = p;
    cur.parts.push(p);
    if (US_CITIES[p]) cur.inferredState = US_CITIES[p];
    else if (FOREIGN_CITIES.has(p)) cur.foreignCity = true;
    else {
      // "Los Angeles Metropolitan Area", "New York City Office"
      const known = Object.keys(US_CITIES).filter((c) => c.length > 2 && containsWords(p, c)).sort((a, b) => b.length - a.length)[0];
      if (known) cur.inferredState = US_CITIES[known];
      // "Roving California" — a state named inside a longer phrase.
      else {
        const named = US_STATES.find(([name]) => containsWords(p, name));
        if (named) { cur.state = named[1]; cur.us = true; }
      }
    }
  }
  next();

  for (const pl of places) {
    // A foreign city with no US state is abroad. With a US state it is not:
    // "Paris, TX", "Vancouver, WA".
    if (pl.foreignCity && !pl.state) pl.foreign = true;
    if (!pl.state && pl.inferredState && !pl.foreign) pl.state = pl.inferredState;
    if (pl.state) pl.us = true;
    pl.countryOnly = !pl.city && !pl.state && !pl.foreign && pl.parts.every((w) => US_COUNTRY.has(w));
  }
  return { remote, places };
}

// ── The operator's accepted places ──────────────────────────────────

/**
 * Parse one `location.allow` entry:
 *   "California" or "CA"    → the whole state
 *   "Seattle, WA"           → that city, in that state
 *   "NYC"                   → that city, any state
 */
export function parseAllowEntry(entry) {
  const parts = String(entry ?? '').split(',').map((p) => fold(p)).filter(Boolean);
  if (parts.length === 1) {
    const p = parts[0];
    if (STATE_BY_NAME.has(p) && !US_CITIES[p]) return { state: STATE_BY_NAME.get(p) };
    if (STATE_CODES.has(p) && p.length === 2 && !US_CITIES[p]) return { state: p };
    return { city: p, state: US_CITIES[p] ?? null };
  }
  const state = STATE_BY_NAME.get(parts[1]) ?? (STATE_CODES.has(parts[1]) ? parts[1] : null);
  return { city: parts[0], state };
}

function segmentMatchesEntry(seg, entry) {
  if (seg.foreign) return false;
  if (entry.city) {
    const names = groupOf(entry.city) ?? [entry.city];
    if (!seg.city || !names.some((n) => containsWords(seg.city, n))) return false;
    return !entry.state || !seg.state || seg.state === entry.state;
  }
  return Boolean(entry.state) && seg.state === entry.state;
}

/**
 * Where the work is, as the operator's allow-list sees it.
 *
 * @param {string} location
 * @param {{allow?: string[]}} loc
 * @returns {'office'|'remote'|'unknown'|'other'}
 *   office   a segment names an accepted place
 *   remote   no accepted office, but remote in the US (or no country named),
 *            or a bare "United States"
 *   unknown  empty, or a placeholder such as "N/A"
 *   other    none of the above: an office somewhere not accepted, or abroad
 */
export function classifyLocation(location, loc = {}) {
  const text = String(location ?? '').trim();
  if (!text || PLACEHOLDER.test(text)) return 'unknown';

  const segs = segments(text).map(readSegment);
  const places = segs.flatMap((s) => s.places);
  const entries = (loc.allow ?? []).map(parseAllowEntry);

  if (entries.length === 0) {
    // No allow-list: any US place is acceptable.
    if (places.some((p) => p.us && !p.foreign && (p.city || p.state))) return 'office';
  } else if (places.some((p) => entries.some((e) => segmentMatchesEntry(p, e)))) {
    return 'office';
  }

  // Remote is acceptable when it is in the US: either the remote segment names
  // the US, or nothing in the whole posting names a place abroad. "United
  // Kingdom · Europe · Remote" is remote in Europe even though its "Remote"
  // segment is bare.
  const postingAbroad = places.some((p) => p.foreign);
  const remoteUS = segs.some((s) => s.remote
    && !s.places.some((p) => p.foreign)
    && (s.places.some((p) => p.us) || !postingAbroad));
  // A bare "United States" means remote in the US only when nothing else in the
  // posting names a US city or state: "United States, Utah, USA" is a Utah
  // posting that happens to lead with its country.
  const bareCountry = places.some((p) => p.countryOnly) && !places.some((p) => p.us && (p.city || p.state));
  if (remoteUS || bareCountry) return 'remote';

  return 'other';
}
