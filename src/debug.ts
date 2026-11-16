import type { WebGLRenderer } from 'three';
import type { Player } from './player';
import type { StreetView } from './streetview';
import { asked, getLimit, setLimit, today } from './requests';
import type { World } from './world';

/**
 * A few lines of figures above the credits, for finding out why something looks or feels wrong:
 * how smooth it is, what the 3D tiles are doing, what the ground under you was measured against,
 * what Street View is doing, and how much has been asked of Google this visit. P shows and hides
 * it (as does holding the compass, on a phone); its code is fetched only once it is wanted.
 *
 * Google does not say how much of the day's quota is left; the count of requests is the nearest
 * there is, with the time Street View was last refused.
 */
const EVERY = 500; // ms between redraws: often enough to read, rarely enough to cost nothing
const WORST_OVER = 5000; // ms the slowest frame is remembered for

export class Debug {

	private panel = document.createElement( 'div' );
	private frames: { t: number, dt: number }[] = [];
	private nextDraw = 0;
	private draws = 0;
	private triangles = 0;

	/** Whether the panel is on screen; requests are counted either way. */
	set shown( on: boolean ) {

		this.panel.hidden = ! on;
		this.nextDraw = 0; // drawn at once, not with figures from when it was hidden
		this.frames.length = 0;
		// counted by hand while shown (over all of a frame's passes); the renderer's own count otherwise
		this.renderer.info.autoReset = ! on;
		if ( ! on ) this.renderer.info.reset();

	}

	get shown() {

		return ! this.panel.hidden;

	}

	constructor( private renderer: WebGLRenderer, private world: World, private player: Player, private streetview: () => StreetView | null ) {

		this.panel.className = 'debug';
		// the last line sets the daily limit (the figure is in the Cloud Console, which Google does not share)
		this.panel.addEventListener( 'click', () => {

			const said = prompt( 'How many Street View photo pieces a day does your key allow?\n(Cloud Console > APIs & Services > Map Tiles API > Quotas: "Street View Tiles requests per day". Leave empty to clear.)', String( getLimit() ?? '' ) );
			if ( said === null ) return;
			const limit = Number( said.replace( /[,\s]/g, '' ) );
			setLimit( said.trim() === '' ? null : Number.isFinite( limit ) && limit > 0 ? limit : getLimit() );
			this.nextDraw = 0;

		} );
		document.querySelector( '#ui .credits' )?.prepend( this.panel );
		this.shown = true;

	}

	/** Called at the end of every frame. */
	update( dt: number, time: number ) {

		if ( this.panel.hidden ) return;
		const info = this.renderer.info.render;
		this.draws = info.calls;
		this.triangles = info.triangles;
		this.renderer.info.reset();
		this.frames.push( { t: time, dt } );
		while ( this.frames.length && this.frames[ 0 ].t < time - WORST_OVER ) this.frames.shift();
		if ( time < this.nextDraw ) return;
		this.nextDraw = time + EVERY;
		this.draw( time );

	}

	private draw( time: number ) {

		const n = ( x: number ) => Math.round( x ).toLocaleString( 'en-GB' );
		const count = ( x: number, one: string, many = `${ one }s` ) => `${ n( x ) } ${ x === 1 ? one : many }`;
		const recent = this.frames.filter( f => f.t > time - 1000 );
		// over the last second, or what there is of it just after appearing
		const fps = recent.length > 1 ? ( recent.length - 1 ) / ( ( recent.at( - 1 )!.t - recent[ 0 ].t ) / 1000 ) : 0;
		const worst = Math.max( 0, ...this.frames.map( f => f.dt ) ) * 1000;
		const triangles = this.triangles >= 1e6 ? `${ ( this.triangles / 1e6 ).toFixed( 1 ) }M` : `${ n( this.triangles / 1000 ) }k`;

		const tiles = this.world.tiles;
		const cache = tiles.lruCache as unknown as { itemSet: Map<unknown, unknown>, cachedBytes: number };
		// not in the library's type definitions, though public (TilesRendererBase.stats)
		const stats = ( tiles as unknown as { stats: Record<'queued' | 'downloading' | 'parsing' | 'visible', number> } ).stats;
		const loading = stats.queued + stats.downloading + stats.parsing;

		const player = this.player;
		const hit = this.world.ground( player.position );
		const from = { below: 'measured below you', top: 'highest surface here', held: 'last known: nothing loaded below', arrival: 'set on arriving' }[ player.groundFrom ];
		const detail = hit?.detail === undefined ? '' : ` · tile detail ${ hit.detail < 10 ? hit.detail.toFixed( 1 ) : n( hit.detail ) } m`;

		const lines = [
			`${ fps ? n( fps ) : '–' } fps · slowest ${ n( worst ) } ms · ${ n( this.draws ) } draws · ${ triangles } triangles`,
			`3D tiles: ${ n( stats.visible ) } drawn · ${ n( cache.itemSet.size ) } kept (${ n( cache.cachedBytes / 1048576 ) } MB) · ${ loading ? `${ n( loading ) } loading` : 'all loaded' }`,
			player.settling ? 'Ground: arriving'
				: `${ player.mode === 'walk' && player.heightAboveGround < 0.1 ? 'Ground underfoot' : `Ground ${ player.heightAboveGround.toFixed( 1 ) } m below` } · ${ from }${ detail }`,
		];
		const sv = this.streetview()?.status;
		if ( sv && sv.what !== 'off' ) {

			const refused = sv.refusedAt ? ` · last refused ${ new Date( sv.refusedAt ).toLocaleTimeString( 'en-GB', { hour: '2-digit', minute: '2-digit' } ) }` : '';
			lines.push( `Street View: ${ sv.shown } of ${ sv.slots } shown · ${ n( sv.kept ) } more in memory · ${ sv.what }${ refused }` );

		}

		const a = asked;
		const street = ( c: typeof asked ) => c.sessions || c.searches ? ` · Street View ${ count( c.searches, 'search', 'searches' ) }, ${ count( c.details, 'detail' ) }, ${ count( c.pieces, 'photo piece' ) }` : '';
		lines.push( `Asked of Google this visit: ${ count( a.tiles, '3D tile' ) }${ street( a ) }` );
		// today's, in this browser alone, against the daily limit the visitor gave (the last line takes a click, to set it)
		const day = today(), limit = getLimit();
		lines.push( `Today, in this browser: ${ count( day.tiles, '3D tile' ) }${ street( day ) }` );
		lines.push( limit
			? `Photo pieces today: ${ n( day.pieces ) } of ${ n( limit ) } allowed (${ n( day.pieces / limit * 100 ) }%) · tap to change the limit`
			: 'Photo pieces allowed a day: not set · tap to set it' );
		this.panel.replaceChildren( ...lines.map( text => Object.assign( document.createElement( 'div' ), { textContent: text } ) ) );

	}

}
