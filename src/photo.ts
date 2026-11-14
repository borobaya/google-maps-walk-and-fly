import { ShaderChunk, Uniform, type Material } from 'three';
import { Effect } from 'postprocessing';

/*
 * Google's 3D tiles are photographs: their light, shadow and colour are already real. So the
 * photos are not lit again. The sky and the clouds are computed in physical light
 * levels, which have to be brought into the range a screen can show by one fixed curve,
 * `ScreenCurveEffect` below. Each photo pixel enters that pipeline as exactly the light the curve
 * turns back into the photo's own colour (its inverse, in the PHOTO code), so it reaches the screen
 * unchanged at every distance; only clouds can pass in front of it.
 */

/** How bright the sky and clouds are drawn. It has no effect on the photos themselves. */
export const EXPOSURE = 4;

// The curve: Narkowicz's fit of the ACES filmic curve, y = x (a x + b) / (x (c x + d) + e), for
// x = light * EXPOSURE. Chosen because it suits a daylight sky and has an exact inverse: solving
// for x, the root of (a - c y) x² + (b - d y) x - e y = 0 (in the PHOTO code below).
const A = 2.51, B = 0.03, C = 2.43, D = 0.59, E = 0.14;
const glsl = ( n: number ) => n.toFixed( 6 );

/** The last step of the sky pass: light to screen colour, by the curve. */
export class ScreenCurveEffect extends Effect {

	constructor() {

		super( 'ScreenCurveEffect', /* glsl */`
			uniform float exposure;
			void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
				vec3 x = max( inputColor.rgb * exposure, 0.0 );
				outputColor = vec4( clamp( x * ( ${ glsl( A ) } * x + ${ glsl( B ) } ) / ( x * ( ${ glsl( C ) } * x + ${ glsl( D ) } ) + ${ glsl( E ) } ), 0.0, 1.0 ), inputColor.a );
			}
		`, { uniforms: new Map( [ [ 'exposure', new Uniform( EXPOSURE ) ] ] ) } );

	}

}

// Every material that ends in `dithering_fragment` (three.js's basic and standard ones do) can be
// told, by the PHOTO define, to hand on its colour as the light that becomes that colour again.
ShaderChunk.dithering_fragment = /* glsl */`
#ifdef PHOTO
{
	vec3 y = clamp( gl_FragColor.rgb, 0.0, 1.0 );
	vec3 a = ${ glsl( A ) } - ${ glsl( C ) } * y;
	vec3 b = ${ glsl( B ) } - ${ glsl( D ) } * y;
	vec3 c = - ${ glsl( E ) } * y;
	gl_FragColor.rgb = ( - b + sqrt( b * b - 4.0 * a * c ) ) / ( 2.0 * a ) / ${ glsl( EXPOSURE ) };
}
#endif
${ ShaderChunk.dithering_fragment }`;

/** Marks a tile's material as a photo, to reach the screen with its own colours. */
export function asPhoto( material: Material ) {

	material.defines = { ...material.defines, PHOTO: '' };
	material.needsUpdate = true;

}
