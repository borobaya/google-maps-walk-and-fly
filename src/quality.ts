/**
 * Rendering and memory settings, chosen once at start-up. A phone or tablet cannot afford
 * the desktop numbers: its browser tab is killed if it holds too much, and its graphics
 * chip draws far fewer pixels per second.
 */
export interface Quality {
	phone: boolean;
	/** Highest rendering resolution, as a multiple of CSS pixels. */
	pixelRatio: number;
	/** How far the resolution may be lowered if frames stay slow. */
	minPixelRatio: number;
	/** Whether the volumetric clouds start switched on. */
	clouds: boolean;
	/** Tile cache: start unloading above `cacheMin`, never exceed `cacheMax` (bytes). */
	cacheMin: number;
	cacheMax: number;
	/** Tiles decoded at once. */
	parseJobs: number;
	/** Screen-space error targets: lower is finer. */
	walkError: number;
	flyError: number;
}

const MB = 2 ** 20;

/** `?profile=phone` or `?profile=desktop` forces a profile, for testing. */
const forced = new URLSearchParams( location.search ).get( 'profile' );
// "the main pointer is a finger" covers phones and tablets (an iPad calls itself a Mac),
// but not a laptop that merely has a touchscreen
const phone = forced ? forced === 'phone' : matchMedia( '(pointer: coarse)' ).matches;

export const quality: Quality = phone ? {
	phone: true,
	pixelRatio: 1.5,
	minPixelRatio: 1,
	clouds: false,
	cacheMin: 150 * MB,
	cacheMax: 220 * MB,
	parseJobs: 4,
	walkError: 6,
	flyError: 16,
} : {
	phone: false,
	pixelRatio: 2,
	minPixelRatio: 2,
	clouds: true,
	cacheMin: 512 * MB,
	cacheMax: 768 * MB,
	parseJobs: 10,
	walkError: 6,
	flyError: 12,
};

/**
 * True when the device is held upright. Asked of the screen where possible, not the window:
 * an on-screen keyboard shrinks the window and would make an upright phone look sideways.
 */
export function upright(): boolean {

	const type = screen.orientation?.type;
	return type ? type.startsWith( 'portrait' ) : window.innerHeight > window.innerWidth;

}
