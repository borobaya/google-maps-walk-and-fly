import type { Player } from './player';
import type { World } from './world';

export const PLACES: Array<{ name: string, lat: number, lng: number }> = [
	{ name: 'London — Tower Bridge', lat: 51.5055, lng: - 0.0754 },
	{ name: 'New York — Midtown', lat: 40.7484, lng: - 73.9857 },
	{ name: 'Paris — Eiffel Tower', lat: 48.8584, lng: 2.2945 },
	{ name: 'San Francisco — Embarcadero', lat: 37.7955, lng: - 122.3937 },
	{ name: 'Tokyo — Tokyo Tower', lat: 35.6586, lng: 139.7454 },
	{ name: 'Sydney — Opera House', lat: - 33.8568, lng: 151.2153 },
	{ name: 'Rome — Colosseum', lat: 41.8902, lng: 12.4922 },
	{ name: 'Grand Canyon', lat: 36.0998, lng: - 112.1125 },
];

/** Parse "51.5, -0.12" (also accepts a pasted Google Maps URL containing @lat,lng). */
export function parseLatLng( text: string ): { lat: number, lng: number } | null {

	const m = text.match( /(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/ );
	if ( ! m ) return null;
	const lat = Number( m[ 1 ] ), lng = Number( m[ 2 ] );
	if ( Math.abs( lat ) > 90 || Math.abs( lng ) > 180 ) return null;
	return { lat, lng };

}

const el = <K extends keyof HTMLElementTagNameMap>( tag: K, cls = '', html = '' ) => {

	const node = document.createElement( tag );
	if ( cls ) node.className = cls;
	if ( html ) node.innerHTML = html;
	return node;

};

let mapsLoading: Promise<any> | null = null;
let mapsDenied = false;
let onDenied: ( () => void ) | null = null;

/** Load Google's Maps JavaScript API on first use (only needed for searching by name). */
function loadMaps( key: string ): Promise<any> {

	mapsLoading ??= new Promise( ( resolve, reject ) => {

		const w = window as any;
		w.__mapsReady = () => resolve( w.google.maps );
		// Google calls this when the key is not allowed to use the Maps JavaScript API
		w.gm_authFailure = () => {

			mapsDenied = true;
			onDenied?.();
			reject( new Error( 'REQUEST_DENIED' ) );

		};
		const script = document.createElement( 'script' );
		script.src = `https://maps.googleapis.com/maps/api/js?key=${ encodeURIComponent( key ) }&loading=async&libraries=geocoding&callback=__mapsReady`;
		script.onerror = () => reject( new Error( 'Could not reach Google' ) );
		document.head.append( script );

	} );
	return mapsLoading;

}

/** Look a place name up with Google's geocoder. Throws an Error with a readable message. */
export async function findPlace( query: string, key: string ): Promise<{ lat: number, lng: number }> {

	try {

		if ( mapsDenied ) throw new Error( 'REQUEST_DENIED' );
		const maps = await loadMaps( key );

		// a blocked key leaves the lookup hanging, so also listen for the denial and give up after a while
		const { results } = await Promise.race( [
			new maps.Geocoder().geocode( { address: query } ),
			new Promise<never>( ( _, reject ) => {

				onDenied = () => reject( new Error( 'REQUEST_DENIED' ) );
				setTimeout( () => reject( new Error( mapsDenied ? 'REQUEST_DENIED' : 'timed out' ) ), 8000 );

			} ),
		] );
		const loc = results[ 0 ].geometry.location;
		return { lat: loc.lat(), lng: loc.lng() };

	} catch ( e: any ) {

		const code = String( e?.code ?? e?.message ?? e );
		if ( code.includes( 'ZERO_RESULTS' ) ) throw new Error( `No place found for "${ query }"` );
		if ( code.includes( 'DENIED' ) || code.includes( 'NotActivated' ) || code.includes( 'ApiTargetBlocked' ) ) {

			throw new Error( 'Searching by name needs the Maps JavaScript API and Geocoding API enabled on your key. Coordinates still work.' );

		}

		throw new Error( `Search failed (${ code })` );

	}

}

export function showSetup( root: HTMLElement ) {

	root.append( el( 'div', 'setup', `
		<h1>Walk &amp; Fly</h1>
		<p>This app needs a Google Maps Platform API key to load the 3D world.</p>
		<ol>
			<li>In <a href="https://console.cloud.google.com/google/maps-apis" target="_blank" rel="noreferrer">Google Cloud Console</a>, enable the <b>Map Tiles API</b> and create an API key.</li>
			<li>Copy <code>.env.example</code> to <code>.env.local</code> in the project folder.</li>
			<li>Paste the key after <code>VITE_GOOGLE_MAPS_API_KEY=</code> and restart the dev server.</li>
		</ol>
		<p class="muted">The key stays on your machine. Google bills tile usage beyond its free monthly allowance.</p>
	` ) );

}

export class Hud {

	onGoTo: ( ( lat: number, lng: number ) => void ) | null = null;

	private mode = el( 'span', 'mode' );
	private stats = el( 'div', 'stats' );
	private hint = el( 'div', 'hint' );
	private credit = el( 'span' );
	private banner = el( 'div', 'banner' );
	private help = el( 'div', 'panel help' );
	private dial = el( 'div', 'dial', '<i>N</i><i>E</i><i>S</i><i>W</i>' );
	private note = el( 'div', 'note' );
	private nextSlow = 0;

	constructor( root: HTMLElement, private player: Player, private world: World, apiKey: string ) {

		// status
		const status = el( 'div', 'panel status' );
		status.append( this.mode, this.stats );

		// go-to
		const go = el( 'form', 'panel goto' );
		const input = el( 'input' );
		input.placeholder = 'Place or lat, lng';
		input.setAttribute( 'aria-label', 'Place name or latitude, longitude' );
		const select = el( 'select' );
		select.setAttribute( 'aria-label', 'Places' );
		select.append( new Option( 'Places…', '' ), ...PLACES.map( ( p, i ) => new Option( p.name, String( i ) ) ) );
		const button = el( 'button', '', 'Go' );
		go.append( input, button, select, this.note );
		go.addEventListener( 'submit', async e => {

			e.preventDefault();
			const text = input.value.trim();
			if ( ! text ) return;
			this.note.textContent = '';
			input.classList.remove( 'bad' );

			// coordinates go straight there; anything else is looked up by name
			let ll = parseLatLng( text );
			if ( ! ll ) {

				button.disabled = true;
				try {

					ll = await findPlace( text, apiKey );

				} catch ( err: any ) {

					this.note.textContent = err.message;
					input.classList.add( 'bad' );

				}

				button.disabled = false;

			}

			if ( ! ll ) return;
			input.blur();
			this.onGoTo?.( ll.lat, ll.lng );

		} );
		select.addEventListener( 'change', () => {

			const p = PLACES[ Number( select.value ) ];
			if ( select.value !== '' && p ) this.onGoTo?.( p.lat, p.lng );
			select.value = '';
			select.blur();

		} );

		this.help.innerHTML = `
			<div class="walk-only"><kbd>↑</kbd><kbd>↓</kbd> forward / back &nbsp;<kbd>←</kbd><kbd>→</kbd> turn</div>
			<div class="fly-only"><kbd>↑</kbd><kbd>↓</kbd> fly forward / back &nbsp;<kbd>←</kbd><kbd>→</kbd> turn</div>
			<div><kbd>A</kbd><kbd>D</kbd> sidestep &nbsp;<kbd>W</kbd><kbd>S</kbd> look up / down</div>
			<div><kbd>Mouse</kbd> hold a button and drag to look</div>
			<div class="walk-only"><kbd>Shift</kbd> run &nbsp;<kbd>Space</kbd> jump</div>
			<div class="walk-only"><kbd>Space</kbd><kbd>Space</kbd> or <kbd>F</kbd> take off</div>
			<div class="fly-only"><kbd>Shift</kbd> boost &nbsp;<kbd>Space</kbd> up &nbsp;<kbd>C</kbd> down &nbsp;<kbd>Scroll</kbd> speed</div>
			<div class="fly-only"><kbd>Space</kbd><kbd>Space</kbd> or <kbd>F</kbd> drop &nbsp;·&nbsp; <kbd>C</kbd> to the ground lands</div>
			<div><kbd>K</kbd> clouds &nbsp;<kbd>U</kbd> hide all &nbsp;<kbd>H</kbd> hide help</div>
		`;
		window.addEventListener( 'keydown', e => {

			if ( e.code === 'KeyH' && ! ( e.target instanceof HTMLInputElement ) ) this.help.classList.toggle( 'hidden' );
			// U hides the whole interface (the attribution stays), for an unobstructed view
			if ( e.code === 'KeyU' && ! ( e.target instanceof HTMLInputElement ) ) document.body.classList.toggle( 'bare' );

		} );

		const credits = el( 'div', 'credits' );
		credits.append( el( 'b', '', 'Google Maps' ), this.credit );

		const compass = el( 'div', 'compass' );
		compass.append( this.dial );
		root.append( compass, status, go, this.help, this.hint, credits, this.banner );

	}

	error( message: string ) {

		this.banner.textContent = `Could not load Google 3D Tiles: ${ message }. Check the API key and that the Map Tiles API is enabled.`;
		this.banner.classList.add( 'show' );

	}

	update( now: number ) {

		const p = this.player;
		document.body.dataset.mode = p.mode;
		document.body.classList.toggle( 'looking', p.dragging );
		this.dial.style.transform = `rotate(${ - p.heading }deg)`;
		this.mode.textContent = p.settling ? 'Loading' : p.mode === 'walk' ? 'Walking' : 'Flying';

		this.hint.textContent = p.settling ? 'Loading terrain…' : p.hasLooked ? '' : 'Hold the mouse button and drag to look around';
		this.hint.classList.toggle( 'show', this.hint.textContent !== '' );

		// text that does not need to change every frame
		if ( now < this.nextSlow ) return;
		this.nextSlow = now + 200;

		const ll = this.world.toLatLng( p.position );
		const kmh = p.speed * 3.6;
		this.stats.innerHTML = p.settling ? '' : `
			<span>${ Math.max( 0, p.heightAboveGround ).toFixed( p.heightAboveGround < 10 ? 1 : 0 ) } m above ground</span>
			<span>${ kmh.toFixed( 0 ) } km/h</span>
			<span>${ compass( p.heading ) } ${ p.heading.toFixed( 0 ) }°</span>
			<span>${ ll.lat.toFixed( 5 ) }, ${ ll.lng.toFixed( 5 ) }</span>
		`;
		// "Google" is already shown as the logo text; list only the other data providers
		this.credit.textContent = this.world.attributions()
			.split( /;\s*/ ).filter( s => s && s !== 'Google' ).join( '; ' );

	}

}

function compass( deg: number ) {

	return [ 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW' ][ Math.round( deg / 45 ) % 8 ];

}
