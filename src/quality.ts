/**
 * Rendering and memory settings, chosen once at start-up. A phone or tablet cannot afford
 * the desktop numbers: its browser tab is killed if it holds too much, and its graphics
 * chip draws far fewer pixels per second.
 */
export interface Quality {
	phone: boolean;
	/** Highest rendering resolution, as a multiple of CSS pixels: the screen's own (as Google Maps draws), lowered only if frames are slow. */
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
	/** Screen-space error targets, in CSS pixels: lower is finer. */
	walkError: number;
	flyError: number;
}

const MB = 2 ** 20;

/** `?profile=phone` or `?profile=desktop` forces a profile, for testing. */
const forced = new URLSearchParams( location.search ).get( 'profile' );
// "the main pointer is a finger" covers phones and tablets (an iPad calls itself a Mac),
// but not a laptop that merely has a touchscreen
const phone = forced ? forced === 'phone' : matchMedia( '(pointer: coarse)' ).matches;

/** Chrome's rounded figure for the device's memory, in GB (at most 8); undefined elsewhere. */
const lowMemory = ( ( navigator as Navigator & { deviceMemory?: number } ).deviceMemory ?? 8 ) < 8;

export const quality: Quality = phone ? {
	phone: true,
	pixelRatio: Infinity,
	minPixelRatio: 1,
	clouds: false,
	cacheMin: 150 * MB,
	cacheMax: 220 * MB,
	parseJobs: 4,
	walkError: 6,
	flyError: 16,
} : {
	phone: false,
	pixelRatio: Infinity,
	minPixelRatio: 2,
	clouds: true,
	// Twice the detail in the air of before (6 rather than 12 pixels of error), which brought the
	// building edges up to Google Maps' own; the larger tile memory keeps those finer tiles. A
	// computer that says it has under 8 GB (Chrome and Edge tell; Safari and Firefox do not) keeps
	// the earlier, smaller memory: the same detail, fetched again more often.
	cacheMin: lowMemory ? 512 * MB : 1024 * MB,
	cacheMax: lowMemory ? 768 * MB : 1536 * MB,
	parseJobs: 10,
	walkError: 6,
	flyError: 6,
};

/**
 * True when the device is held upright. Asked of the screen where possible, not the window:
 * an on-screen keyboard shrinks the window and would make an upright phone look sideways.
 */
export function upright(): boolean {

	const type = screen.orientation?.type;
	return type ? type.startsWith( 'portrait' ) : window.innerHeight > window.innerWidth;

}

/**
 * True when the page was opened from a home-screen icon (an installed web app) and so has
 * no browser bars. Read once at start-up, before the Fullscreen button could confuse it.
 */
export const installed: boolean = matchMedia( '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)' ).matches
	|| ( navigator as { standalone?: boolean } ).standalone === true;
