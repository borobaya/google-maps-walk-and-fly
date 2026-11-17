/**
 * Requests to Google, by kind, for the debug panel (debug.ts): this visit's, and today's in this
 * browser. Counted from the start, from the browser's own record of what the page fetched: the
 * panel's code arrives later, and by then the browser keeps only its last 250 or so. Only each
 * address's path is looked at, never the whole of it, which carries the key.
 *
 * Google's daily limits are counted per project, from midnight Pacific time, and it does not say
 * how much is left. Today's count is only this browser's share (other tabs add to it; other devices
 * and anything else using the key do not), so it is an estimate, set against Google's default limits (QUOTAS).
 */
export interface Counts { tiles: number, roots: number, searches: number, details: number, pieces: number, sessions: number }
const zero = (): Counts => ( { tiles: 0, roots: 0, searches: 0, details: 0, pieces: 0, sessions: 0 } );

/** The limits on the key's Map Tiles API quotas, as Google sets them by default (Cloud Console > APIs & Services > Map Tiles API > Quotas). */
export const QUOTAS = {
	tilesPerMinute: 12000, // "3D Tiles renderer requests per minute"
	piecesPerMinute: 6000, // "Street View Tiles requests per minute"
	rootsPerDay: 10000, // "3D Tiles root requests per day"
	piecesPerDay: 15000, // "Street View Tiles requests per day"
};

/** When each recent 3D tile and photo piece was asked for, for the per-minute quotas. */
const recent = { tiles: [] as number[], pieces: [] as number[] };
/** How many of each were asked for in the last minute, in this browser. */
export const lastMinute = () => {

	const from = performance.now() - 60000;
	for ( const list of Object.values( recent ) ) while ( list.length && list[ 0 ] < from ) list.shift();
	return { tiles: recent.tiles.length, pieces: recent.pieces.length };

};

/** This visit's. */
export const asked = zero();

const TODAY_STORE = 'walk-and-fly-requests-today';
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

try {

	// what is stored from earlier today, so the count starts there
	const stored = JSON.parse( localStorage.getItem( TODAY_STORE ) ?? 'null' ) as { day?: string, counts?: unknown } | null;
	if ( stored?.day === day() ) { saved = clean( stored.counts ); savedDay = stored.day; }

} catch { /* storage blocked */ }

const count = ( kind: keyof Counts, at: number ) => {

	asked[ kind ] ++;
	unsaved[ kind ] ++;
	if ( kind === 'tiles' || kind === 'pieces' ) {

		// kept to the last minute here, so it stays small even if the panel is never opened
		const list = recent[ kind ];
		list.push( at );
		while ( list[ 0 ] < at - 60000 ) list.shift();

	}

};

try {

	new PerformanceObserver( list => {

		for ( const e of list.getEntries() ) {

			if ( ! e.name.startsWith( 'https://tile.googleapis.com/' ) ) continue;
			const path = new URL( e.name ).pathname;
			if ( path === '/v1/3dtiles/root.json' ) count( 'roots', e.startTime );
			if ( path.startsWith( '/v1/3dtiles/' ) ) count( 'tiles', e.startTime );
			else if ( path === '/v1/streetview/panoIds' ) count( 'searches', e.startTime );
			else if ( path === '/v1/streetview/metadata' ) count( 'details', e.startTime );
			else if ( path.startsWith( '/v1/streetview/tiles/' ) ) count( 'pieces', e.startTime );
			else if ( path === '/v1/createSession' ) count( 'sessions', e.startTime );

		}

	} ).observe( { type: 'resource', buffered: true } );

	// saved every few seconds, and as the page goes
	setInterval( () => { if ( Object.values( unsaved ).some( Boolean ) ) save(); }, SAVE_EVERY );
	window.addEventListener( 'pagehide', () => { if ( Object.values( unsaved ).some( Boolean ) ) save(); } );

} catch { /* no record kept in this browser: the panel shows nothing asked */ }
