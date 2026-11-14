# Security

Walk & Fly runs entirely in the visitor's browser and keeps their Google API key there. The page's
content security policy (in `vite.config.ts`) lets it talk only to Google, and `npm test` checks
that the key reaches Google and nowhere else.

## Reporting a problem

If you find a way for the key to leave the visitor's browser for anywhere but Google, or any other
security problem, please report it privately: on GitHub, open the repository's **Security** tab
and choose **Report a vulnerability**. Please do not open a public issue for it.

You should hear back within a week.

## Your own key

If you think your key has been exposed, delete or regenerate it in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials), and keep it restricted
to the Map Tiles API and to the websites that use it.
