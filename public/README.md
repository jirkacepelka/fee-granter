Static files served from the site root: `public/og.svg` is `/og.svg`.

The theme icons are inline SVG (Lucide, and the OG mark), so they render in the
current text colour and cost no request. Anything dropped here is fetched
separately instead — fine for images, not for icons.
