# authentik with this repo's blueprints baked in, so a redeploy always gets the same groups,
# applications and flows (see ../README.md). Server and worker both run this image.

# The sites' look comes from SharedUI's brand/ folder (palette.json and logo.svg), downloaded
# from a tagged SharedUI release so a build is always reproducible. To take a new SharedUI
# release, bump SHAREDUI_REF. The local all-sites stack swaps in the sibling SharedUI/brand
# folder instead (../../local/identity.override.yaml overrides this stage).
FROM scratch AS sharedui-brand
ARG SHAREDUI_REF=v1.0.0
ADD https://raw.githubusercontent.com/thebensage-dev/SharedUI/${SHAREDUI_REF}/brand/palette.json /palette.json
ADD https://raw.githubusercontent.com/thebensage-dev/SharedUI/${SHAREDUI_REF}/brand/logo.svg /logo.svg

# The sites' colours, filled into the branding below from palette.json. sharp draws the email
# logo PNG from logo.svg.
FROM node:26-alpine AS brand
WORKDIR /brand
RUN npm install --no-save --no-package-lock --no-audit --no-fund sharp@0.35.5
COPY render-brand.mjs brand.css ./
COPY brand/ brand/
COPY templates/ templates/
COPY --from=sharedui-brand /palette.json ./palette.json
COPY --from=sharedui-brand /logo.svg brand/logo.svg
RUN node render-brand.mjs /out

# Pinned to an exact release; Dependabot proposes newer tags. Read the release notes first:
# authentik only supports upgrading one minor line at a time (e.g. 2026.8 -> 2026.11).
FROM ghcr.io/goauthentik/server:2026.8.7

# Everything under /blueprints is discovered and applied by the worker on start, and again
# whenever a file changes.
COPY blueprints/ /blueprints/custom/

# The sites' look on authentik's pages: custom CSS (read by the blueprint with !File), and the
# logo, favicon and background, served by authentik at /static/dist/assets/brand/.
COPY --from=brand /out/brand.css /setup/brand.css
COPY --from=brand /out/brand/ /web/dist/assets/brand/

# Emails in the sites' look (templates/email/site_base.html), used by the blueprint's policies.
# /templates is authentik's custom email template folder. Every email attaches authentik's
# icon_left_brand.png as its logo (cid:logo), so ours replaces it.
COPY --from=brand /out/templates/ /templates/
COPY --from=brand /out/brand/email-logo.png /web/dist/assets/icons/icon_left_brand.png

# Footer links (privacy notice and terms), applied by the authentik-settings service.
COPY settings.py /setup/settings.py
