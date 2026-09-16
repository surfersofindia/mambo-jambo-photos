/* Requests use the site origin; Vercel and the local server proxy /api to the Worker.
 * The Hostinger subdomain has no such proxy, so it calls the Worker directly (CORS-enabled). */
const WORKER_URL = 'https://mambo-jambo-photo-api.surfersofindia.workers.dev';
window.MJ_CONFIG = { apiUrl: window.location.hostname === 'photos.surfersofindia.com' ? WORKER_URL : window.location.origin };
