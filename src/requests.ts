/**
 * Requests to Google, by kind, for the debug panel (debug.ts): this visit's, and today's in this
 * browser. Counted from the start, from the browser's own record of what the page fetched: the
 * panel's code arrives later, and by then the browser keeps only its last 250 or so. Only each
 * address's path is looked at, never the whole of it, which carries the key.
 *
 * Google's daily limits are counted per project, from midnight Pacific time, and it does not say
 * how much is left. Today's count is only this browser's share (other tabs add to it; other devices
 * and anything else using the key do not), so it is an estimate, set against a limit the visitor
 * gives from the Cloud Console.
 */
export interface Counts { tiles: number, searches: number, details: number, pieces: number, sessions: number }
const zero = (): Counts => ( { tiles: 0, searches: 0, details: 0, pieces: 0, sessions: 0 } );

/** This visit's. */
export const asked = zero();

const TODAY_STORE = 'walk-and-fly-requests-today';
const LIMIT_STORE = 'walk-and-fly-photo-piece-limit';
const SAVE_EVERY = 2000; // ms

/** What was saved today, and what has been counted since. */
let saved = zero();
let unsaved = zero();
let savedDay = '';
let pacific: Intl.DateTimeFormat | null = null;
const day = () => ( pacific ??= new Intl.DateTimeFormat( 'en-CA', { timeZone: 'America/Los_Angeles' } ) ).format( new Date() );

const clean = ( c: unknown ): Counts => {

	const out = zero();
	for ( const k of Object.keys( out ) as ( keyof Counts )[] ) {

		const v = ( c as Partial<Counts> | null )?.[ k ];
		if ( typeof v === 'number' && Number.isFinite( v ) && v > 0 ) out[ k ] = v;

	}

	return out;

};

/** Adds what has been counted since the last save to what is stored, so other tabs' counts are kept too. */
const save = () => {

	try {

		const today = day();
		const stored = JSON.parse( localStorage.getItem( TODAY_STORE ) ?? 'null' ) as { day?: string, counts?: unknown } | null;
		const base = stored?.day === today ? clean( stored.counts ) : zero();
		for ( const k of Object.keys( base ) as ( keyof Counts )[] ) base[ k ] += unsaved[ k ];
		localStorage.setItem( TODAY_STORE, JSON.stringify( { day: today, counts: base } ) );
		saved = base;
		savedDay = today;
		unsaved = zero();

	} catch { /* storage blocked: today's count is then this visit's alone */ }

};

/** Today's count in this browser: saved, plus what is not saved yet. */
export const today = (): Counts => {

	const out = zero();
	// a new day since the last save: yesterday's is no longer today's
	const fresh = savedDay === '' || savedDay === day();
	for ( const k of Object.keys( out ) as ( keyof Counts )[] ) out[ k ] = ( fresh ? saved[ k ] : 0 ) + unsaved[ k ];
	return out;

};

/** Most Street View photo pieces a day the key allows, as the visitor says (from the Cloud Console), or null. */
export const getLimit = (): number | null => {

	try {

		const n = Number( localStorage.getItem( LIMIT_STORE ) );
		return Number.isFinite( n ) && n > 0 ? n : null;

	} catch { return null; }

};

export const setLimit = ( limit: number | null ) => {

	try {

		if ( limit === null ) localStorage.removeItem( LIMIT_STORE ); else localStorage.setItem( LIMIT_STORE, String( Math.round( limit ) ) );

	} catch { /* storage blocked: not remembered */ }

};

try {

	// what is stored from earlier today, so the count starts there
	const stored = JSON.parse( localStorage.getItem( TODAY_STORE ) ?? 'null' ) as { day?: string, counts?: unknown } | null;
	if ( stored?.day === day() ) { saved = clean( stored.counts ); savedDay = stored.day; }

} catch { /* storage blocked */ }

const count = ( kind: keyof Counts ) => { asked[ kind ] ++; unsaved[ kind ] ++; };

try {

	new PerformanceObserver( list => {

		for ( const e of list.getEntries() ) {

			if ( ! e.name.startsWith( 'https://tile.googleapis.com/' ) ) continue;
			const path = new URL( e.name ).pathname;
			if ( path.startsWith( '/v1/3dtiles/' ) ) count( 'tiles' );
			else if ( path === '/v1/streetview/panoIds' ) count( 'searches' );
			else if ( path === '/v1/streetview/metadata' ) count( 'details' );
			else if ( path.startsWith( '/v1/streetview/tiles/' ) ) count( 'pieces' );
			else if ( path === '/v1/createSession' ) count( 'sessions' );

		}

	} ).observe( { type: 'resource', buffered: true } );

	// saved every few seconds, and as the page goes
	setInterval( () => { if ( Object.values( unsaved ).some( Boolean ) ) save(); }, SAVE_EVERY );
	window.addEventListener( 'pagehide', () => { if ( Object.values( unsaved ).some( Boolean ) ) save(); } );

} catch { /* no record kept in this browser: the panel shows nothing asked */ }
