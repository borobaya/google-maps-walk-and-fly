import { defineConfig, type Plugin } from 'vite';

// What the page may load and talk to. The visitor's API key sits in this page, so it may reach
// only Google (and the site itself): a change that tried to send the key anywhere else would be
// blocked in the visitor's browser. Keep this list as short as the app allows.
const POLICY = {
	'default-src': [ "'self'" ],
	// the Draco decoder is WebAssembly; searching by name loads Google's Maps script
	'script-src': [ "'self'", "'wasm-unsafe-eval'", 'https://maps.googleapis.com', 'https://maps.gstatic.com' ],
	// map tiles; place search
	'connect-src': [ "'self'", 'data:', 'blob:', 'https://tile.googleapis.com', 'https://maps.googleapis.com' ],
	'img-src': [ "'self'", 'data:', 'blob:', 'https://maps.googleapis.com', 'https://maps.gstatic.com' ],
	'worker-src': [ "'self'", 'blob:' ],
	'style-src': [ "'self'", "'unsafe-inline'" ],
	'object-src': [ "'none'" ],
	'base-uri': [ "'self'" ],
	'form-action': [ "'none'" ],
};

/**
 * Writes the policy into the page. The same policy serves the dev server: its live-reload socket
 * is on the page's own host, which 'self' covers. (A `ws:` source would also match every http and
 * https address, which Safari's engine honours, quietly letting the page talk to any site.)
 */
const contentSecurityPolicy = (): Plugin => ( {
	name: 'content-security-policy',
	transformIndexHtml: () => {

		const content = Object.entries( POLICY ).map( ( [ name, values ] ) => `${ name } ${ values.join( ' ' ) }` ).join( '; ' );
		return [ { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' } ];

	},
} );

/** The files the app needs to open at all; the rest are cached as they are first used. */
const SHELL_FILES = [ 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'google-maps-logo.svg' ];

/**
 * The service worker, so the home-screen app opens straight away, even with no signal. It is
 * written at build time with the names of this build's files, and only ever touches requests
 * to the site itself: Google's tiles and scripts carry the visitor's key and are Google's to
 * serve, so they are never cached. Pages come from the network first (a new version shows on
 * the next launch), falling back to the copy kept from last time; the site's other files, whose
 * names change whenever their content does, come from the cache first.
 */
const serviceWorker = (): Plugin => ( {
	name: 'service-worker',
	apply: 'build',
	generateBundle( _, bundle ) {

		const files = Object.values( bundle );
		const entry = files.filter( f => f.type === 'chunk' && f.isEntry );
		const scripts = new Set( entry.flatMap( f => f.type === 'chunk' ? [ f.fileName, ...f.imports ] : [] ) );
		const styles = files.filter( f => f.type === 'asset' && f.fileName.endsWith( '.css' ) ).map( f => f.fileName );
		const shell = [ './', ...scripts, ...styles, ...SHELL_FILES ];
		// the build's file names change with their content, so together they name this version
		let hash = 2166136261;
		for ( const c of files.map( f => f.fileName ).sort().join( '|' ) ) hash = Math.imul( hash ^ c.charCodeAt( 0 ), 16777619 ) >>> 0;
		const version = hash.toString( 36 );

		this.emitFile( { type: 'asset', fileName: 'sw.js', source: `// Walk & Fly's service worker, written at build time (see vite.config.ts).
const CACHE = 'walk-and-fly-${ version }';
const SHELL = ${ JSON.stringify( shell ) };
const PAGE = new URL( './', self.registration.scope ).href; // every visit, whatever its address, is the same page

self.addEventListener( 'install', event => {

	event.waitUntil( caches.open( CACHE ).then( cache => cache.addAll( SHELL ) ) );

} );

// A new version takes over only once every page of the old one is closed (no skipWaiting), so an
// open page can still fetch its own version's files from the old cache until then.
self.addEventListener( 'activate', event => {

	event.waitUntil( caches.keys().then( keys => Promise.all(
		keys.filter( key => key.startsWith( 'walk-and-fly-' ) && key !== CACHE ).map( key => caches.delete( key ) ),
	) ) );

} );

self.addEventListener( 'fetch', event => {

	const request = event.request;
	if ( request.method !== 'GET' || new URL( request.url ).origin !== self.location.origin ) return;
	event.respondWith( request.mode === 'navigate' ? fromNetwork( event ) : fromCache( request ) );

} );

// the page: the network if it answers within three seconds, otherwise the copy from last time
async function fromNetwork( event ) {

	const fresh = fetch( event.request ).then( response => {

		if ( response.ok ) {

			const copy = response.clone();
			event.waitUntil( caches.open( CACHE ).then( cache => cache.put( PAGE, copy ) ) );

		}

		return response;

	} );
	try {

		const first = await Promise.race( [ fresh, new Promise( resolve => setTimeout( resolve, 3000, 'slow' ) ) ] );
		if ( first !== 'slow' ) return first;
		return ( await caches.match( PAGE ) ) ?? await fresh; // slow: the copy now, the network refreshes it

	} catch {

		return ( await caches.match( PAGE ) ) ?? Response.error(); // offline

	}

}

// everything else on the site: the cache if it has it, otherwise the network (and keep a copy)
async function fromCache( request ) {

	const cached = await caches.match( request, { ignoreSearch: true } );
	if ( cached ) return cached;
	const response = await fetch( request );
	if ( response.ok ) {

		const copy = response.clone();
		caches.open( CACHE ).then( cache => cache.put( request, copy ) );

	}

	return response;

}
` } );

	},
} );

export default defineConfig( {
	// relative paths, so the built site works at any address (such as a GitHub Pages sub-folder)
	base: './',
	plugins: [ contentSecurityPolicy(), serviceWorker() ],
	build: {
		rolldownOptions: {
			output: {
				codeSplitting: {
					// The libraries (three.js, the tiles renderer, the sky) change far less often than the
					// app, so they get a chunk of their own that stays cached across deploys. The clouds stay
					// out of it: they are fetched only when switched on, which a phone never does.
					groups: [
						{ name: 'vendor', test: /node_modules[\\/](?!@takram[\\/]three-clouds)/ },
						{ name: 'clouds', test: /node_modules[\\/]@takram[\\/]three-clouds/ },
					],
				},
			},
		},
		// the libraries' chunk is large by nature (three.js alone is most of it); warn only beyond it
		chunkSizeWarningLimit: 1100,
	},
	resolve: {
		// every library must share one copy of three.js, or instanceof checks between them fail
		dedupe: [ 'three' ],
	},
	optimizeDeps: {
		include: [ 'three', '3d-tiles-renderer', '3d-tiles-renderer/plugins', 'postprocessing', '@takram/three-atmosphere', '@takram/three-clouds', '@takram/three-geospatial' ],
	},
} );
