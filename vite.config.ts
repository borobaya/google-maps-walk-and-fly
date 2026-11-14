import { defineConfig, type Plugin } from 'vite';

// What the page may load and talk to. The visitor's API key sits in this page, so it may reach
// only Google (and the site itself): a change that tried to send the key anywhere else would be
// blocked in the visitor's browser. Keep this list as short as the app allows.
const POLICY = {
	'default-src': [ "'self'" ],
	// the Draco decoder is WebAssembly; searching by name loads Google's Maps script
	'script-src': [ "'self'", "'wasm-unsafe-eval'", 'https://maps.googleapis.com', 'https://maps.gstatic.com' ],
	// map tiles; place search; the clouds' noise texture (from the three-geospatial project)
	'connect-src': [ "'self'", 'data:', 'blob:', 'https://tile.googleapis.com', 'https://maps.googleapis.com', 'https://media.githubusercontent.com' ],
	'img-src': [ "'self'", 'data:', 'blob:', 'https://maps.googleapis.com', 'https://maps.gstatic.com' ],
	'worker-src': [ "'self'", 'blob:' ],
	'style-src': [ "'self'", "'unsafe-inline'" ],
	'object-src': [ "'none'" ],
	'base-uri': [ "'self'" ],
	'form-action': [ "'none'" ],
};

/** Writes the policy into the page; the dev server also needs its live-reload connection. */
const contentSecurityPolicy = (): Plugin => {

	let serving = false;
	return {
		name: 'content-security-policy',
		configResolved: config => { serving = config.command === 'serve'; },
		transformIndexHtml: () => {

			const policy = structuredClone( POLICY );
			if ( serving ) policy[ 'connect-src' ].push( 'ws:', 'wss:' );
			const content = Object.entries( policy ).map( ( [ name, values ] ) => `${ name } ${ values.join( ' ' ) }` ).join( '; ' );
			return [ { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' } ];

		},
	};

};

export default defineConfig( {
	// relative paths, so the built site works at any address (such as a GitHub Pages sub-folder)
	base: './',
	plugins: [ contentSecurityPolicy() ],
	resolve: {
		// every library must share one copy of three.js, or instanceof checks between them fail
		dedupe: [ 'three' ],
	},
	optimizeDeps: {
		include: [ 'three', '3d-tiles-renderer', '3d-tiles-renderer/plugins', 'postprocessing', '@takram/three-atmosphere', '@takram/three-clouds', '@takram/three-geospatial' ],
	},
} );
