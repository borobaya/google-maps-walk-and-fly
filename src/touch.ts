import type { Player } from './player';
import { quality } from './quality';

/**
 * On-screen buttons for touch devices. Moving and looking are plain drags on the scene, handled
 * by the player (see `Player.oneThumb` for the two schemes); nothing is drawn for them. These
 * buttons cover what a drag cannot: going straight up or down, and switching between walking
 * and flying.
 *
 * They are shown while `body.touch` is set. On a phone or tablet that is always. A laptop with
 * a touchscreen gets it while the screen is what is being used, and goes back to the keyboard
 * help as soon as a key or the mouse is.
 */
export function addTouchControls( root: HTMLElement, player: Player ) {

	const pad = document.createElement( 'div' );
	pad.className = 'pad';

	const button = ( cls: string, html: string, label: string ) => {

		const b = document.createElement( 'button' );
		b.type = 'button';
		b.className = cls;
		b.innerHTML = html;
		b.setAttribute( 'aria-label', label );
		pad.append( b );
		return b;

	};

	const mode = button( 'mode', '<span class="walk-only">Fly</span><span class="fly-only">Walk</span>', 'Switch between walking and flying' );
	const up = button( 'up', '▲', 'Jump, or climb when flying' );
	const down = button( 'down fly-only', '▼', 'Descend' );

	mode.addEventListener( 'click', () => player.toggleMode() );

	// ▲ and ▼ act for as long as they are held
	const hold = ( b: HTMLElement, y: number ) => {

		let pointer: number | null = null;
		const release = () => {

			pointer = null;
			if ( player.stick.y === y ) player.stick.y = 0;
			b.classList.remove( 'held' );

		};
		b.addEventListener( 'pointerdown', e => {

			e.preventDefault();
			try { b.setPointerCapture( e.pointerId ); } catch { /* the pointer is already gone */ }
			pointer = e.pointerId;
			player.stick.y = y;
			b.classList.add( 'held' );

		} );
		b.addEventListener( 'pointerup', release );
		b.addEventListener( 'pointercancel', release );
		b.addEventListener( 'lostpointercapture', release );
		// ▼ is hidden the moment it lands you, and a hidden button may not hear its own release
		const elsewhere = ( e: PointerEvent ) => { if ( e.pointerId === pointer ) release(); };
		window.addEventListener( 'pointerup', elsewhere );
		window.addEventListener( 'pointercancel', elsewhere );
		b.addEventListener( 'contextmenu', e => e.preventDefault() ); // a long press is not a right-click

	};
	hold( up, 1 );
	hold( down, - 1 );

	root.append( pad );

	if ( quality.phone ) document.body.classList.add( 'touch' );
	else {

		const touch = ( on: boolean ) => document.body.classList.toggle( 'touch', on );
		window.addEventListener( 'pointerdown', e => touch( e.pointerType === 'touch' ) );
		window.addEventListener( 'keydown', () => touch( false ) );

	}

}
