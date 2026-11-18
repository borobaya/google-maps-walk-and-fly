import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import { upright } from './quality';
import type { World } from './world';

export type Mode = 'walk' | 'fly';

/** How you were when you left a place, so you can be put back the same way. */
export interface Resume {
	mode: Mode;
	/** compass bearing, degrees */
	heading: number;
	pitch: number;
	/** eye height above the ellipsoid, metres (what `World.toLatLng` reports) */
	height: number;
}

const EYE = 1.7; // eye height above the feet, metres
const RADIUS = 0.4; // body radius for wall checks
const STEP = 0.6; // tallest ledge you can step onto
const WALK_SPEED = 4;
const RUN_SPEED = 11;
const JUMP_SPEED = 5.5;
const GRAVITY = 20;
const TERMINAL = 70;
const FLY_CLEARANCE = 1.2;
const SPAWN_HEIGHT = 180; // metres above ground after a teleport
const REANCHOR_DISTANCE = 1000;
const LOOK_SENSITIVITY = 0.004; // radians per pixel dragged
const TOUCH_LOOK_SENSITIVITY = 0.005; // a thumb has less room to travel than a mouse
const STICK_DEAD = 8; // pixels a thumb may wander before it counts as moving
const STICK_FULL = 60; // pixels of drag for full walking / flying pace
const STICK_FAST = 90; // drag this far to run or boost
const TURN_DEAD = 14; // one-thumb steering: sideways pixels ignored, so going straight stays straight
const ONE_THUMB_PITCH = - 0.25; // one-thumb flying looks slightly down at the world, radians
const KEY_TURN_RATE = 2.0; // rad/s when turning with the arrow keys
const KEY_PITCH_RATE = 1.2; // rad/s when tilting the view with W / S
/**
 * Field of view, degrees from top to bottom of a landscape screen (see main.ts for an upright
 * one). On foot it is wide, as in most first-person games; in the air it is narrower, nearer
 * Google Maps' own 3D view (35), so the city looks calm and undistorted rather than fish-eyed.
 */
const BASE_FOV = 70;
const FLY_FOV = 50;
/**
 * The flying view at a given height above the ground: the walking view while skimming the
 * street, narrowing to FLY_FOV as you climb. The change is spread evenly over the doublings of
 * height (5, 10, 20 … 200 m), so it is as gradual near the ground as high up.
 */
const LOW = 5, HIGH = 200;
/**
 * How long the view takes to settle at a new angle, seconds. It moves like a critically damped
 * spring: it sets off gently, glides, and arrives gently, never overshooting, so neither the
 * angle nor the speed at which it changes ever jumps, whatever the reason for the change
 * (taking off or landing, speeding up or stopping, arriving somewhere).
 */
const FOV_EASE = 0.6;

function flyFov( height: number ) {

	const t = MathUtils.clamp( Math.log( Math.max( height, 0.01 ) / LOW ) / Math.log( HIGH / LOW ), 0, 1 );
	return MathUtils.lerp( BASE_FOV, FLY_FOV, t * t * ( 3 - 2 * t ) );

}
const MAX_DROP = 150; // a ground reading this far below the last one is not believed straight away
const BODY = 1.0; // when flying, stay at least this far from walls on every side
const FEELER = 60; // how far to look for nearby walls, metres
const LIFT_START = 0.25; // going straight up or down begins at this share of flying speed...
const LIFT_RAMP = 1.5; // ...and reaches all of it after being held this long, seconds
const DOUBLE_TAP = 0.3; // seconds between Space presses that toggles flying
const TAP_SLOP = 12; // pixels a finger may wander and still be a tap
const TAP_TIME = 0.3; // longest a tap may last, seconds
const DOUBLE_TAP_GAP = 0.4; // longest between the two taps of a double tap, seconds
const DOUBLE_TAP_APART = 40; // furthest apart the two taps may land, pixels
const WHEEL_FULL = 15; // pixels of a two-finger swipe, in one event, for full pace
const WHEEL_FAST = 60; // a harder swipe than this runs (on foot) or boosts (flying), as a long thumb drag does
const WHEEL_STRAY = 0.4; // a swipe's weaker direction counts only above this share of the stronger one
const WHEEL_HOLD = 120; // ms a wheel event keeps pushing, so a swipe's stream of them is one smooth movement
/** A double click goes this share of the way to what was clicked on, between these limits (metres), walking. */
const GLIDE_SHARE = 0.5, GLIDE_LEAST = 1.5, GLIDE_MOST = 60;
const FLY_SIDE = 0.75; // flying sideways is this share of flying forward
const FLY_SPEED_LEAST = 15, FLY_SPEED_MOST = 5000; // flying speed is your height above the ground each second, within these (m/s)
const GLIDE_BLIND = 8; // metres walked when the click was on the sky, or nothing was hit
const GLIDE_BLIND_FLYING = 40;
const GLIDE_HEIGHTS = 3; // flying, at most this many times your height above the ground (and never under GLIDE_MOST), however far off the click was

const UP = new Vector3( 0, 1, 0 );

export class Player {

	mode: Mode = 'fly';
	/** Eye position in scene space. */
	readonly position = new Vector3( 0, 1500, 0 );
	readonly velocity = new Vector3();
	yaw = Math.PI; // facing north
	pitch = - 0.35;
	/** True while waiting for terrain to load under a new location. */
	settling = true;
	/** Height of the feet (walk) or eyes (fly) above the surface below. */
	heightAboveGround = 0;
	speed = 0;
	/** Distance to the nearest wall around you (capped), used to set how close the camera can draw. */
	clearance = 60;
	/** Frames in flight where no ground could be found (tiles still loading); for diagnostics. */
	groundMisses = 0;
	/**
	 * Where the last ground height came from, for the debug panel: measured straight below you, the
	 * highest surface in your column (below was empty: slipped under the mesh, or still loading), the
	 * last one known (nothing loaded under you yet), or set on arriving.
	 */
	groundFrom: 'below' | 'top' | 'held' | 'arrival' = 'arrival';
	/** True while a mouse button or a finger is held on the scene to look around. */
	dragging = false;
	/**
	 * Analog input from the touch screen, added to the keys: x sidestep, z forward, y up
	 * (each -1..1), turn right (-1..1). z, x and turn come from the moving thumb's drag, y from
	 * the ▲ ▼ buttons.
	 */
	readonly stick = { x: 0, z: 0, y: 0, turn: 0, fast: false };
	/** True while the last thing used to steer was a finger (not the mouse or keyboard). */
	private touching = false;
	/** True once the mouse has been used to look, so the hint can go away. */
	hasLooked = false;
	/** Camera field of view in degrees; set by height and eased, never by speed. */
	fov = BASE_FOV;

	private keys = new Set<string>();
	private grounded = false;
	private renderY = 1500;
	private settleTime = 0;
	private lastSpace = - Infinity;
	private lastGround = - Infinity;
	private suspectFrames = 0;
	private speedHeight = SPAWN_HEIGHT;
	private fovTarget = BASE_FOV;
	/** How fast the view angle is changing, degrees per second (see FOV_EASE). */
	private fovRate = 0;
	private liftTime = 0;
	private liftSign = 0;
	/** Seconds spent hovering since the last clearance check (moving counts as due). */
	private stillFor = 1;
	private resume: Resume | null = null;
	/** A two-finger swipe (sent as wheel events): how hard it pushes you forward (+) or back (-), and until when. */
	private wheelPush = 0;
	/** The same sideways: right (+) or left (-). */
	private wheelSide = 0;
	private wheelFast = false;
	private wheelUntil = 0;
	/** A double click sets you off toward what was clicked on: its direction in scene space, and the metres still to go. */
	private glide: { dir: Vector3, left: number, age: number, stuck: number, mode: Mode } | null = null;
	private lookPointer: number | null = null;
	private movePointer: number | null = null;
	/** Upright, a second finger down beside the moving one: the drag then steps aside instead of turning. */
	private sidePointer: number | null = null;
	/** Where the moving finger is now, for working out the stick again when the second finger comes or goes. */
	private moveNowX = 0;
	private moveNowY = 0;
	private lookX = 0;
	private lookY = 0;
	private moveX = 0;
	private moveY = 0;

	private forward = new Vector3();
	private right = new Vector3();
	private move = new Vector3();
	private tmp = new Vector3();
	private last = new Vector3();

	private world: World;
	private camera: PerspectiveCamera;
	private dom: HTMLElement;

	constructor( world: World, camera: PerspectiveCamera, dom: HTMLElement ) {

		this.world = world;
		this.camera = camera;
		this.dom = dom;
		camera.rotation.order = 'YXZ';
		this.bindInput();

	}

	/**
	 * A phone held upright is steered with one thumb: a drag anywhere moves you forward or back
	 * and turns you. There is no looking up or down, so the view keeps a fixed tilt and flying
	 * forward stays level. Held sideways it is the usual two-thumb layout of mobile games: the
	 * left half moves and the right half looks.
	 */
	/** True while something is being held to steer: a key, a mouse button or a finger on the scene, ▲ ▼, or a swipe. */
	get steering(): boolean {

		return this.keys.size > 0 || this.dragging || this.movePointer !== null || this.stick.y !== 0 || this.pushing;

	}

	/** Whether a swipe is pushing you now. */
	private get pushing(): boolean {

		return performance.now() < this.wheelUntil && ( this.wheelPush !== 0 || this.wheelSide !== 0 );

	}

	get oneThumb(): boolean {

		return this.touching && upright();

	}

	get heading(): number {

		// compass bearing in degrees, clockwise from north
		return MathUtils.euclideanModulo( 180 - this.yaw * MathUtils.RAD2DEG, 360 );

	}

	/**
	 * Jump to a place on Earth. You arrive in the air above it, or, given `resume`,
	 * at the same height, facing the same way and in the same mode as when you left.
	 */
	teleport( lat: number, lng: number, resume: Resume | null = null ) {

		this.world.anchor( lat, lng );
		this.position.set( 0, 1500, 0 );
		this.renderY = 1500;
		this.velocity.set( 0, 0, 0 );
		this.pitch = - 0.35;
		this.mode = 'fly';
		this.grounded = false;
		this.settling = true;
		this.settleTime = 0;
		this.lastGround = - Infinity;
		this.resume = resume;
		this.glide = null;
		this.wheelUntil = 0;
		if ( resume ) {

			this.yaw = ( 180 - resume.heading ) * MathUtils.DEG2RAD;
			this.pitch = MathUtils.clamp( resume.pitch, - 1.55, 1.55 );

		}

	}

	toggleMode() {

		if ( this.settling ) return;
		if ( this.mode === 'fly' ) {

			// fold the wings: gravity takes over until you land
			this.glide = null;
			this.mode = 'walk';
			this.grounded = false;

		} else {

			this.mode = 'fly';
				this.velocity.y = Math.max( this.velocity.y, 6 );

		}

	}

	update( dt: number ) {

		this.keyLook( dt );
		this.last.copy( this.position );

		if ( this.settling ) this.settle( dt );
		else if ( this.mode === 'walk' ) this.walk( dt );
		else this.fly( dt );

		if ( this.glide ) this.advanceGlide( dt );
		this.speed = this.settling ? 0 : this.position.distanceTo( this.last ) / dt;
		this.reanchor();
		this.applyCamera( dt );

	}

	// --- movement -------------------------------------------------------

	private settle( dt: number ) {

		const top = this.world.topSurface( this.position );
		if ( top === null ) return;

		// give the coarse terrain a moment to refine before trusting its height
		this.settleTime += dt;
		if ( this.settleTime < 0.8 ) return;
		const resume = this.resume;
		this.resume = null;
		// The world is anchored at ellipsoid height 0 here, so scene Y is height above the ellipsoid.
		// Only go back to a remembered height that still makes sense against the terrain now loaded.
		if ( resume && resume.height > top - 50 && resume.height < top + 20000 ) {

			this.position.y = resume.height;
			this.mode = resume.mode;
			// on foot you are set down at eye height and the walk code finds the ground under you
			this.lastGround = resume.mode === 'walk' ? resume.height - EYE : top;
			this.heightAboveGround = Math.max( 0, this.position.y - this.lastGround );

		} else {

			this.position.y = top + SPAWN_HEIGHT;
			this.lastGround = top;
			this.heightAboveGround = SPAWN_HEIGHT;

		}

		this.speedHeight = this.heightAboveGround;
		this.renderY = this.position.y;
		this.groundFrom = 'arrival';
		this.settling = false;

	}

	private axes() {

		const k = this.keys, t = this.stick;
		const unit = ( v: number ) => MathUtils.clamp( v, - 1, 1 );
		const g = this.glide ? this.glideAxes() : null;
		return {
			z: unit( ( k.has( 'ArrowUp' ) ? 1 : 0 ) - ( k.has( 'ArrowDown' ) ? 1 : 0 ) + t.z + ( this.pushing ? this.wheelPush : 0 ) + ( g?.z ?? 0 ) ),
			x: unit( ( k.has( 'KeyD' ) ? 1 : 0 ) - ( k.has( 'KeyA' ) ? 1 : 0 ) + t.x + ( this.pushing ? this.wheelSide : 0 ) + ( g?.x ?? 0 ) ),
			y: unit( ( k.has( 'Space' ) ? 1 : 0 ) - ( k.has( 'KeyC' ) ? 1 : 0 ) + t.y + ( g?.y ?? 0 ) ),
			// running and boosting are a long drag on a touch screen; the keyboard has no key for them
			fast: t.fast || ( this.pushing && this.wheelFast ),
		};

	}

	/** The double click's direction, as the forward, sideways and up input that goes that way from where you face. */
	private glideAxes() {

		const d = this.glide!.dir;
		const sin = Math.sin( this.yaw ), cos = Math.cos( this.yaw );
		const ahead = - d.x * sin - d.z * cos, side = d.x * cos - d.z * sin;
		if ( this.mode === 'walk' ) return { z: ahead, x: side, y: 0 };
		// flying: forward is level, sideways is FLY_SIDE as fast, and up is its own axis, so the
		// direction clicked is just these three
		const z = ahead, y = d.y;
		// sideways can come to more than 1, which the inputs are cut to: scaled together
		// instead, so they still add up to the direction clicked
		const sidestep = side / FLY_SIDE;
		const most = Math.max( 1, Math.abs( sidestep ) );
		return { z: z / most, x: sidestep / most, y: y / most };

	}

	/** Counts the double click's distance down as you go, and ends it on arriving, running into something, or any other input. */
	private advanceGlide( dt: number ) {

		const g = this.glide!;
		// landing (or taking off) on the way ends it: the way to go differs on foot and in the air
		if ( this.mode !== g.mode || this.keys.size > 0 || this.pushing || this.movePointer !== null || this.stick.y !== 0 ) return void ( this.glide = null );
		// progress is the speed toward where it is going: sliding along a wall it ran into is none
		const walking = this.mode === 'walk';
		const along = Math.max( 0, walking ? this.velocity.x * g.dir.x + this.velocity.z * g.dir.z : this.velocity.dot( g.dir ) );
		g.age += dt;
		g.left -= along * dt;
		g.stuck = g.age > 0.4 && along < 0.5 ? g.stuck + dt : 0;
		// stopping takes a moment (walking is quick about it), so it lets go a little before the end
		if ( g.left <= along * ( walking ? 0.08 : 0.25 ) || g.stuck > 0.25 ) this.glide = null;

	}

	/** A double click: set off toward what is under the pointer, part of the way. */
	private goToward( clientX: number, clientY: number ) {

		if ( this.settling ) return;
		const box = this.dom.getBoundingClientRect();
		const dir = new Vector3( ( clientX - box.left ) / box.width * 2 - 1, - ( clientY - box.top ) / box.height * 2 + 1, 0.5 )
			.unproject( this.camera ).sub( this.camera.position ).normalize();
		const hit = this.world.cast( this.camera.position, dir );
		const walking = this.mode === 'walk';
		if ( walking ) dir.setY( 0 );
		const flat = Math.hypot( dir.x, dir.z );
		if ( walking && flat < 0.2 ) return; // aimed at your feet or straight up: no way to go
		if ( walking ) dir.divideScalar( flat );
		// part of the way there, never all of it, so you end up standing short of the wall or the lamp post
		const away = hit ? ( walking ? hit.distance * flat : hit.distance ) : Infinity;
		// the most grows with height in the air, as flying speed does: low it is fine steps, high it is whole streets
		const most = walking ? GLIDE_MOST : Math.max( GLIDE_MOST, GLIDE_HEIGHTS * this.heightAboveGround );
		const left = hit ? MathUtils.clamp( away * GLIDE_SHARE, GLIDE_LEAST, most ) : Math.min( walking ? GLIDE_BLIND : GLIDE_BLIND_FLYING, most );
		this.glide = { dir, left, age: 0, stuck: 0, mode: this.mode };

	}

	private walk( dt: number ) {

		const { world, position, velocity } = this;
		const a = this.axes();

		// horizontal intent, relative to where you face
		this.forward.set( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
		this.right.set( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );
		const target = this.move.set( 0, 0, 0 )
			.addScaledVector( this.forward, a.z )
			.addScaledVector( this.right, a.x );
		// keys give full pace (a diagonal is not faster); a thumb gives pace in proportion to its drag
		if ( target.lengthSq() > 1 ) target.normalize();
		target.multiplyScalar( a.fast ? RUN_SPEED : WALK_SPEED );

		// quick response on the ground, little control in the air
		const blend = 1 - Math.exp( - dt * ( this.grounded ? 12 : 1.5 ) );
		velocity.x += ( target.x - velocity.x ) * blend;
		velocity.z += ( target.z - velocity.z ) * blend;

		this.blockWalls( dt );
		position.x += velocity.x * dt;
		position.z += velocity.z * dt;
		// keep the eyes off walls on every side (not just ahead), so the view cannot cut into them
		this.keepClear( RADIUS );

		// vertical: follow the ground, or fall
		let feet = position.y - EYE;
		const probe = this.tmp.set( position.x, feet, position.z );
		// in the air the feet may already be below a surface, so look down from eye level
		let ground = this.trusted( world.groundBelow( probe, this.grounded ? STEP : EYE ) );
		if ( ground !== null ) this.groundFrom = 'below';

		if ( ground === null ) {

			// nothing below: either we slipped under the mesh or it is not loaded yet
			const top = world.topSurface( probe );
			if ( top === null || top < this.lastGround - MAX_DROP ) {

				// no ground we can believe in: stay put until the tiles arrive
				velocity.y = 0;
				this.groundFrom = 'held';
				return;

			}

			this.groundFrom = 'top';
			ground = feet = top;
			this.grounded = true;
			velocity.y = 0;

		}

		if ( this.grounded ) {

			if ( a.y > 0 ) {

				velocity.y = JUMP_SPEED;
				this.grounded = false;

			} else if ( feet - ground > STEP ) {

				this.grounded = false; // walked off a ledge

			} else {

				feet = ground;
				velocity.y = 0;

			}

		}

		if ( ! this.grounded ) {

			// bump your head on anything overhead
			if ( velocity.y > 0 ) {

				const head = this.tmp.set( position.x, feet + EYE, position.z );
				if ( world.cast( head, UP, velocity.y * dt + 0.25 ) ) velocity.y = 0;

			}

			velocity.y = Math.max( velocity.y - GRAVITY * dt, - TERMINAL );
			feet += velocity.y * dt;
			if ( feet <= ground && velocity.y <= 0 ) {

				feet = ground;
				velocity.y = 0;
				this.grounded = true;

			}

		}

		position.y = feet + EYE;
		this.heightAboveGround = feet - ground;
		this.lastGround = ground;
		this.fovTarget = BASE_FOV;

	}

	/**
	 * Stop horizontal motion into steep surfaces, sliding along them instead.
	 * Feelers at knee, waist and head height, plus one at each shoulder, give the
	 * body some width so it cannot clip corners or squeeze through gaps.
	 */
	private blockWalls( dt: number ) {

		const { world, position, velocity } = this;
		const feet = position.y - EYE;
		const waist = feet + 1.0;
		const side = RADIUS * 0.85;

		for ( let pass = 0; pass < 2; pass ++ ) {

			const dir = this.move.set( velocity.x, 0, velocity.z );
			const stepLength = dir.length() * dt;
			if ( stepLength < 1e-5 ) return;
			dir.normalize();

			// [ sideways offset, height ]
			const feelers = [
				[ 0, feet + STEP + 0.1 ], [ 0, waist ], [ 0, position.y - 0.1 ],
				[ side, waist ], [ - side, waist ],
			];

			let blocked = false;
			for ( const [ offset, height ] of feelers ) {

				// dir is horizontal, so ( -dir.z, 0, dir.x ) points to one side
				const origin = this.tmp.set( position.x - dir.z * offset, height, position.z + dir.x * offset );
				const hit = world.cast( origin, dir, RADIUS + stepLength );
				if ( ! hit || Math.abs( hit.normal.y ) > 0.7 ) continue;

				const n = hit.normal.setY( 0 ).normalize();
				const into = velocity.x * n.x + velocity.z * n.z;
				if ( into < 0 ) {

					velocity.x -= n.x * into;
					velocity.z -= n.z * into;

				}

				blocked = true;
				break;

			}

			if ( ! blocked ) return;

		}

		// still blocked after sliding (a corner): stop
		velocity.x = velocity.z = 0;

	}

	/**
	 * Feel around in flight: push away from anything closer than BODY (so the view never
	 * pokes through a wall or a steep hillside) and note the nearest obstacle.
	 */
	private keepClear( body = BODY ) {

		const { world, position } = this;
		// Only as far as the camera could use (see main.ts, which keeps its near plane within half of
		// the clearance, and that within a twentieth of your height): a long ray looks through every
		// tile along its way, which in a dense street is most of the cost of a frame on a phone.
		const reach = Math.min( FEELER, Math.max( body * 2, this.heightAboveGround * 0.12 ) );
		let nearest = reach;
		const sin = Math.sin( this.yaw ), cos = Math.cos( this.yaw );
		const dirs = [ [ - sin, 0, - cos ], [ sin, 0, cos ], [ cos, 0, - sin ], [ - cos, 0, sin ], [ 0, 1, 0 ] ];

		for ( const [ x, y, z ] of dirs ) {

			const dir = this.move.set( x, y, z );
			const hit = world.cast( position, dir, reach );
			if ( ! hit ) continue;

			if ( hit.distance < body ) {

				position.addScaledVector( dir, hit.distance - body );
				const into = this.velocity.dot( dir );
				if ( into > 0 ) this.velocity.addScaledVector( dir, - into );
				hit.distance = body;

			}

			nearest = Math.min( nearest, hit.distance );

		}

		this.clearance = nearest;

	}

	/**
	 * While tiles are being swapped for finer ones there can briefly be a hole under you, and a
	 * ray through it reports "ground" kilometres down. Ignore a reading that suddenly drops far
	 * below the last one unless it keeps saying so (a real cliff edge does).
	 */
	private trusted( ground: number | null ): number | null {

		if ( ground === null ) return null;
		if ( ground < this.lastGround - MAX_DROP && ++ this.suspectFrames < 30 ) return null;
		this.suspectFrames = 0;
		return ground;

	}

	private fly( dt: number ) {

		const { world, position, velocity } = this;
		const a = this.axes();
		// forward and back keep your height however you look: the view only aims the camera, and
		// height changes only with the up and down controls
		this.forward.set( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
		this.right.set( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );

		// faster the higher you are, so streets and whole cities both feel right
		// (the height is smoothed, so passing over a rooftop or a cliff edge does not jolt your speed)
		this.speedHeight += ( this.heightAboveGround - this.speedHeight ) * ( 1 - Math.exp( - dt * 1.5 ) );
		const base = MathUtils.clamp( this.speedHeight, FLY_SPEED_LEAST, FLY_SPEED_MOST ); // a height a second
		const top = base * ( a.fast ? 3 : 1 );

		// Straight up or down starts gently, for small adjustments, and builds to full flying
		// speed the longer it is held, so a long climb or descent does not crawl.
		const sign = Math.sign( a.y );
		this.liftTime = sign !== 0 && sign === this.liftSign ? this.liftTime + dt : 0;
		this.liftSign = sign;
		// (a double click's glide goes up or down at the pace it goes forward, so it keeps the line clicked)
		const lift = this.glide ? 1 : LIFT_START + ( 1 - LIFT_START ) * Math.min( 1, this.liftTime / LIFT_RAMP );

		// You only move while a key is held: forward or (more slowly) backward level,
		// sideways, and straight up or down. Let go and you come to a stop.
		const target = this.move.set( 0, 0, 0 )
			.addScaledVector( this.forward, a.z > 0 ? a.z * top : a.z * top * 0.5 )
			.addScaledVector( this.right, a.x * top * FLY_SIDE )
			.addScaledVector( UP, a.y * top * lift );

		// ease in and out quickly, so starts and stops are smooth but there is no gliding on
		velocity.addScaledVector( target.sub( velocity ), 1 - Math.exp( - dt * 4 ) );
		if ( target.lengthSq() === 0 && velocity.lengthSq() < 0.01 ) velocity.set( 0, 0, 0 );

		// don't fly through buildings or hillsides: slide along them
		const stepLength = velocity.length() * dt;
		if ( stepLength > 1e-5 ) {

			const dir = this.tmp.copy( velocity ).normalize();
			const hit = world.cast( position, dir, stepLength + FLY_CLEARANCE );
			if ( hit ) {

				// treat lumpy, overhanging walls as vertical so you can always climb up them
				if ( Math.abs( hit.normal.y ) < 0.7 ) hit.normal.setY( 0 ).normalize();
				const into = velocity.dot( hit.normal );
				if ( into < 0 ) velocity.addScaledVector( hit.normal, - into );

			}

		}

		position.addScaledVector( velocity, dt );
		// five rays, which are costly beside buildings on a phone: hovering, ten times a second is enough
		this.stillFor = velocity.lengthSq() > 1e-4 ? 1 : this.stillFor + dt;
		if ( this.stillFor >= 0.1 ) { this.keepClear(); this.stillFor = 0; }

		// keep above the surface
		const ground = this.trusted( world.groundBelow( position ) );
		if ( ground !== null ) {

			this.groundFrom = 'below';
			if ( position.y < ground + FLY_CLEARANCE ) {

				position.y = ground + FLY_CLEARANCE;
				velocity.y = Math.max( velocity.y, 0 );

			}

			// descending onto the ground lands you
			if ( a.y < 0 && position.y < ground + FLY_CLEARANCE + 0.3 ) {

				// stand on the surface (eyes are higher on foot than when skimming it)
				this.mode = 'walk';
				this.grounded = true;
				velocity.set( 0, 0, 0 );
				position.y = ground + EYE;
				// the ▼ button disappears under the finger on landing and may never hear the release
				if ( this.stick.y < 0 ) this.stick.y = 0;

			}

			this.heightAboveGround = position.y - ground;
			this.lastGround = ground;

		} else {

			const topSurface = world.topSurface( position );
			if ( topSurface !== null && topSurface > position.y ) {

				position.y = topSurface + FLY_CLEARANCE;
				velocity.y = Math.max( velocity.y, 0 );
				this.groundFrom = 'top';
				this.heightAboveGround = FLY_CLEARANCE;
				this.lastGround = topSurface;

			} else {

				// Nothing reliable to measure against: the tiles here are still loading. Hold the
				// last known ground level so you cannot sink through the world in the meantime.
				this.groundMisses ++;
				this.groundFrom = 'held';
				if ( position.y < this.lastGround + FLY_CLEARANCE ) {

					position.y = this.lastGround + FLY_CLEARANCE;
					velocity.y = Math.max( velocity.y, 0 );

				}

				this.heightAboveGround = position.y - this.lastGround;

			}

		}

		// the view depends on your height alone: nothing widens or tilts as you speed up or turn
		this.fovTarget = flyFov( this.heightAboveGround );

	}

	/** Keep the player near the scene origin so "up" stays up anywhere on Earth. */
	private reanchor() {

		const p = this.position;
		if ( Math.hypot( p.x, p.z ) < REANCHOR_DISTANCE ) return;

		const dir = this.tmp.set( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
		const dy = this.renderY - p.y;
		const dGround = this.lastGround - p.y;
		this.world.reanchorOn( p, dir );
		this.lastGround = p.y + dGround;
		this.yaw = Math.atan2( - dir.x, - dir.z );
		this.renderY = p.y + dy;

	}

	private applyCamera( dt: number ) {

		const cam = this.camera;

		// smooth out steps and kerbs while walking
		if ( this.mode === 'walk' && this.grounded ) {

			this.renderY += ( this.position.y - this.renderY ) * ( 1 - Math.exp( - dt * 18 ) );

		} else {

			this.renderY = this.position.y;

		}

		// No banking into turns, no widening with speed and no bounce in your step: the view only
		// turns where you turn it, which is easier on the stomach. (Arriving somewhere you start high
		// up, unless you are coming back to where you left off on foot.)
		const still = this.mode !== 'fly' ? BASE_FOV
			: this.settling ? ( this.resume?.mode === 'walk' ? BASE_FOV : FLY_FOV )
				: flyFov( this.heightAboveGround );
		this.ease( this.settling ? still : this.fovTarget, dt );

		cam.position.set( this.position.x, this.renderY, this.position.z );
		cam.rotation.set( this.pitch, this.yaw, 0 );
		cam.updateMatrixWorld();

	}

	// --- input ----------------------------------------------------------

	/** Turn the view by these angles (radians): positive dx turns right, positive dy looks down. */
	look( dx: number, dy: number ) {

		this.yaw -= dx;
		this.pitch = MathUtils.clamp( this.pitch - dy, - 1.55, 1.55 );

	}

	private keyLook( dt: number ) {

		const k = this.keys;
		const x = ( k.has( 'ArrowRight' ) ? 1 : 0 ) - ( k.has( 'ArrowLeft' ) ? 1 : 0 ) + this.stick.turn;
		const y = ( k.has( 'KeyS' ) ? 1 : 0 ) - ( k.has( 'KeyW' ) ? 1 : 0 ); // W looks up, S looks down
		if ( x || y ) this.look( x * KEY_TURN_RATE * dt, y * KEY_PITCH_RATE * dt );

		// one thumb cannot tilt the view, so hold it level on foot and slightly down in the air
		if ( this.oneThumb ) {

			const rest = this.mode === 'fly' ? ONE_THUMB_PITCH : 0;
			this.pitch += ( rest - this.pitch ) * ( 1 - Math.exp( - dt * 2.5 ) );

		}

		// keyboard-only walking: the view drifts back to level as you move, like classic shooters
		const moving = k.has( 'ArrowUp' ) || k.has( 'ArrowDown' );
		if ( this.mode === 'walk' && moving && ! y && ! this.dragging ) {

			this.pitch *= Math.exp( - dt * 2.5 );

		}

	}

	private bindInput() {

		const dom = this.dom;
		const typing = ( e: Event ) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;

		window.addEventListener( 'keydown', e => {

			// leave browser and system shortcuts (Ctrl+W, Cmd+R, ...) alone
			if ( typing( e ) || e.metaKey || e.ctrlKey ) return;
			if ( e.code === 'KeyF' && ! e.repeat ) this.toggleMode();
			if ( e.code === 'Space' && ! e.repeat ) {

				// double-tap Space to take off or land
				const now = performance.now() / 1000;
				if ( now - this.lastSpace < DOUBLE_TAP ) {

					this.toggleMode();
					this.lastSpace = - Infinity;

				} else {

					this.lastSpace = now;

				}

			}

			if ( e.code === 'Space' || e.code.startsWith( 'Arrow' ) ) e.preventDefault();
			this.touching = false;
			this.keys.add( e.code );

		} );
		window.addEventListener( 'keyup', e => this.keys.delete( e.code ) );

		// Pointer events cover the mouse, fingers and pens alike.
		// - Mouse or pen: steers the view, but only while a button is held down on the scene.
		// - Finger, phone held sideways: the left half is an invisible thumbstick, centred wherever
		//   the thumb lands; the right half steers the view.
		// - Finger, phone held upright: the whole screen is that thumbstick, and sideways turns.
		const releaseLook = () => {

			this.lookPointer = null;
			this.dragging = false;

		};
		const releaseMove = () => {

			this.movePointer = null;
			this.sidePointer = null;
			this.stick.x = this.stick.z = this.stick.turn = 0;
			this.stick.fast = false;

		};
		// the thumb stick, from where the moving finger is now against where it landed
		const steer = () => {

			const dx = this.moveNowX - this.moveX, dy = this.moveNowY - this.moveY;
			const length = Math.hypot( dx, dy );
			const live = length > STICK_DEAD;
			this.stick.z = live ? MathUtils.clamp( - dy / STICK_FULL, - 1, 1 ) : 0;
			if ( this.oneThumb && this.sidePointer === null ) {

				// sideways drag turns instead of sidestepping
				const side = Math.max( 0, Math.abs( dx ) - TURN_DEAD ) * Math.sign( dx );
				this.stick.turn = MathUtils.clamp( side / STICK_FULL, - 1, 1 );
				this.stick.x = 0;

			} else {

				// two thumbs, or two fingers on a phone held upright: sideways steps aside
				this.stick.x = live ? MathUtils.clamp( dx / STICK_FULL, - 1, 1 ) : 0;
				this.stick.turn = 0;

			}

			// one thumb: only the forward or backward part counts, so a wide turn is not a boost
			this.stick.fast = ( this.oneThumb ? Math.abs( dy ) : length ) > STICK_FAST;

		};
		const release = ( e: PointerEvent ) => {

			if ( e.pointerId === this.lookPointer ) releaseLook();
			if ( e.pointerId === this.movePointer ) releaseMove();
			if ( e.pointerId === this.sidePointer ) {

				this.sidePointer = null;
				steer();

			}

		};
		const letGo = () => {

			this.keys.clear();
			this.stick.y = 0;
			releaseLook();
			releaseMove();

		};

		dom.addEventListener( 'pointerdown', e => {

			// leave any text box, so the keys go back to moving you
			if ( document.activeElement instanceof HTMLElement ) document.activeElement.blur();
			this.hasLooked = true;
			this.touching = e.pointerType === 'touch';

			// upright: any finger moves and turns. Sideways: the left half moves, the right half looks.
			if ( e.pointerType === 'touch' && ( this.oneThumb || e.clientX < window.innerWidth / 2 ) ) {

				if ( this.movePointer !== null ) {

					// upright, a second finger: the drag now steps aside (it is only counted, so no capture)
					if ( this.oneThumb && this.sidePointer === null ) { this.sidePointer = e.pointerId; steer(); }
					return;

				}

				this.movePointer = e.pointerId;
				this.moveX = this.moveNowX = e.clientX;
				this.moveY = this.moveNowY = e.clientY;

			} else {

				if ( this.lookPointer !== null ) return;
				this.lookPointer = e.pointerId;
				this.lookX = e.clientX;
				this.lookY = e.clientY;
				this.dragging = true;

			}

			// keep receiving this pointer's moves even when it strays over the interface
			try { dom.setPointerCapture( e.pointerId ); } catch { /* the pointer is already gone */ }

		} );
		dom.addEventListener( 'pointermove', e => {

			if ( e.pointerId === this.lookPointer ) {

				// a mouse release we never heard about (outside the window, behind a menu) still ends the drag
				if ( e.pointerType === 'mouse' && e.buttons === 0 ) return releaseLook();
				// measured from positions: Safari does not report movementX/Y reliably for touch
				const s = e.pointerType === 'touch' ? TOUCH_LOOK_SENSITIVITY : LOOK_SENSITIVITY;
				this.look( ( e.clientX - this.lookX ) * s, ( e.clientY - this.lookY ) * s );
				this.lookX = e.clientX;
				this.lookY = e.clientY;

			} else if ( e.pointerId === this.movePointer ) {

				this.moveNowX = e.clientX;
				this.moveNowY = e.clientY;
				steer();

			}

		} );
		dom.addEventListener( 'pointerup', release );
		// A double tap goes part of the way toward what was tapped, as a double click does with a mouse
		// (the browser sends no double click for a touch we have claimed). A tap is a touch that stays put
		// and is short, with no other finger down.
		const fingers = new Set<number>();
		let tap: { id: number, x: number, y: number, at: number } | null = null;
		let lastTap = { x: 0, y: 0, at: - Infinity };
		dom.addEventListener( 'pointerdown', e => {

			if ( e.pointerType !== 'touch' ) return;
			fingers.add( e.pointerId );
			tap = fingers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() / 1000 } : null;

		} );
		dom.addEventListener( 'pointermove', e => {

			if ( tap && e.pointerId === tap.id && Math.hypot( e.clientX - tap.x, e.clientY - tap.y ) > TAP_SLOP ) tap = null;

		} );
		dom.addEventListener( 'pointercancel', e => { fingers.delete( e.pointerId ); tap = null; } );
		dom.addEventListener( 'pointerup', e => {

			fingers.delete( e.pointerId );
			if ( ! tap || e.pointerId !== tap.id ) return;
			const now = performance.now() / 1000;
			const short = now - tap.at < TAP_TIME;
			const second = now - lastTap.at < DOUBLE_TAP_GAP && Math.hypot( tap.x - lastTap.x, tap.y - lastTap.y ) < DOUBLE_TAP_APART;
			if ( short && second ) { lastTap.at = - Infinity; this.goToward( tap.x, tap.y ); }
			else lastTap = short ? { x: tap.x, y: tap.y, at: now } : { ...lastTap, at: - Infinity };
			tap = null;

		} );
		dom.addEventListener( 'pointercancel', release );
		dom.addEventListener( 'lostpointercapture', release );
		// no context menu over the scene: it would swallow the button release and leave the view steering
		dom.addEventListener( 'contextmenu', e => e.preventDefault() );
		// A drag that starts at the screen edge is Safari's "go back" swipe. Claiming the touch here
		// stops that where Safari allows it; the pointer events above still arrive.
		dom.addEventListener( 'touchstart', e => e.preventDefault(), { passive: false } );
		// a phone that switches apps does not always send `blur`
		window.addEventListener( 'blur', letGo );
		document.addEventListener( 'visibilitychange', () => { if ( document.hidden ) letGo(); } );

		// A two-finger swipe on a trackpad (or a mouse wheel) over the scene moves you: swiping up
		// goes forward and down goes back, swiping right steps aside to the right and left to the left
		// (with the computer's own "natural" scrolling; the other way round if that is switched off).
		// A swipe is a stream of wheel events, each pushing for a moment, so it moves as smoothly as
		// the swipe. Fingers drift a little off straight, so a swipe's weaker direction is ignored
		// unless it is nearly as strong as the other.
		dom.addEventListener( 'wheel', e => {

			e.preventDefault();
			if ( e.ctrlKey ) return; // a pinch: zooms nothing
			const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
			let along = e.deltaY * lines, across = e.deltaX * lines;
			if ( Math.abs( along ) < Math.abs( across ) * WHEEL_STRAY ) along = 0;
			if ( Math.abs( across ) < Math.abs( along ) * WHEEL_STRAY ) across = 0;
			this.wheelPush = MathUtils.clamp( along / WHEEL_FULL, - 1, 1 );
			this.wheelSide = MathUtils.clamp( - across / WHEEL_FULL, - 1, 1 );
			this.wheelFast = Math.max( Math.abs( along ), Math.abs( across ) ) >= WHEEL_FAST;
			this.wheelUntil = performance.now() + WHEEL_HOLD;

		}, { passive: false } );
		// a double click goes part of the way toward what was clicked on (a touch screen has its thumb stick)
		dom.addEventListener( 'dblclick', e => { if ( ! this.touching && e.button === 0 ) this.goToward( e.clientX, e.clientY ); } );
		// a trackpad's pinch (sent as a wheel with Ctrl) zooms the page nowhere, over the panels and boxes included
		window.addEventListener( 'wheel', e => { if ( e.ctrlKey ) e.preventDefault(); }, { passive: false } );

	}

	/** Moves the view angle towards `target` without any jump in it or in its rate (see FOV_EASE). */
	private ease( target: number, dt: number ) {

		// the smooth-damp step of Game Programming Gems 4, 1.10: a critically damped spring
		const w = 2 / FOV_EASE, x = w * dt;
		const decay = 1 / ( 1 + x + 0.48 * x * x + 0.235 * x * x * x );
		const offset = this.fov - target;
		const pull = ( this.fovRate + w * offset ) * dt;
		this.fovRate = ( this.fovRate - w * pull ) * decay;
		this.fov = target + ( offset + pull ) * decay;

	}

}
