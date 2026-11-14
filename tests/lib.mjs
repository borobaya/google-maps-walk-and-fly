// What the test suites share: finding Chrome, starting it, and reporting checks.
import puppeteer from 'puppeteer-core';

export const CHROME = process.env.CHROME ?? {
	darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[ process.platform ] ?? '/usr/bin/google-chrome';

// Headless Chrome has to be told to use the real graphics chip, and how differs by system.
// SOFTWARE=1 draws on the processor instead: slow, but it works where there is no chip (CI).
export const GPU = process.env.SOFTWARE
	? [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader' ]
	: [ '--enable-gpu', '--ignore-gpu-blocklist', ...( process.platform === 'darwin' ? [ '--use-angle=metal' ] : [] ) ];

export const PORTRAIT = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
export const LANDSCAPE = { ...PORTRAIT, width: 844, height: 390, isLandscape: true };
export const SHORT = { ...LANDSCAPE, height: 292 }; // what Safari leaves on an iPhone held sideways, with its bars showing

export const sleep = ms => new Promise( r => setTimeout( r, ms ) );

export const launch = ( viewport, args = [] ) => puppeteer.launch( {
	executablePath: CHROME,
	headless: true,
	// CI machines run as root, where Chrome's sandbox cannot start
	args: [ ...GPU, ...( process.env.CI ? [ '--no-sandbox' ] : [] ), ...args ],
	defaultViewport: viewport,
} );

let failed = 0;
export const check = ( name, ok, detail ) => {

	if ( ! ok ) failed ++;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } ${ name }${ detail === undefined ? '' : `  ${ JSON.stringify( detail ) }` }` );

};
/** Prints the total and exits, failing if any check did. */
export const finish = () => {

	console.log( failed ? `\n${ failed } failed` : '\nall passed' );
	process.exit( failed ? 1 : 0 );

};

/** Every visible piece of the interface: which pairs overlap, and which poke off the screen. */
export const layout = page => page.evaluate( () => {

	const names = [ '.status', '.compass', '.goto-open', '.goto', '.pad .mode', '.pad .up', '.pad .down', '.credits', '.hint', '.help' ];
	const boxes = [];
	for ( const name of names ) {

		const node = document.querySelector( name ), style = getComputedStyle( node ), r = node.getBoundingClientRect();
		if ( style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || r.width === 0 ) continue;
		boxes.push( { name, r } );

	}

	const problems = [];
	for ( const { name, r } of boxes ) if ( r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 ) problems.push( `${ name } off screen` );
	for ( let i = 0; i < boxes.length; i ++ ) for ( let j = i + 1; j < boxes.length; j ++ ) {

		const a = boxes[ i ].r, b = boxes[ j ].r;
		if ( a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 ) problems.push( `${ boxes[ i ].name } over ${ boxes[ j ].name }` );

	}

	return problems;

} );

/** Waits until the tiles around you have finished loading (or 40 seconds have passed). */
export const loaded = async page => {

	for ( let i = 0, steady = 0; i < 200 && steady < 8; i ++ ) {

		steady = await page.evaluate( () => world.tiles.loadProgress ) >= 1 ? steady + 1 : 0;
		await sleep( 200 );

	}

};

/** Records the page's uncaught errors, and anything its security policy blocks, in `errors`. */
export const guard = async ( page, errors ) => {

	page.on( 'pageerror', e => errors.push( e.message ) );
	page.on( 'console', m => { if ( m.text().startsWith( 'blocked by the page policy: ' ) ) errors.push( m.text() ); } );
	await page.evaluateOnNewDocument( () => {

		document.addEventListener( 'securitypolicyviolation', e => console.warn( `blocked by the page policy: ${ e.violatedDirective } ${ e.blockedURI.split( '?' )[ 0 ] }` ) );

	} );

};
