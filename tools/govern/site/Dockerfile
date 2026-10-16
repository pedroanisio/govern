# The govern website. Build context is tools/govern:
#   docker build -f site/Dockerfile --build-arg SITE_COMMIT=$(git rev-parse --short HEAD) -t govern-site .
#   docker run --rm -p 8080:80 govern-site

# 1. Render the press release PDF (press/ is the press lane's folder).
FROM python:3.13-slim AS press
WORKDIR /work
COPY press/ ./press/
COPY site/static/brand/press-banner.png site/static/brand/logo.png ./brand/
RUN pip install --no-cache-dir -r press/requirements.txt \
 && python press/render.py --out press/dist --banner brand/press-banner.png --logo brand/logo.png

# 2. Build the site. build.ts imports lib/shape.ts and lib/util.ts, and reads package.json for the version.
FROM node:24-alpine AS build
ARG SITE_COMMIT=unknown
WORKDIR /app
COPY package.json ./
COPY lib/shape.ts lib/util.ts ./lib/
COPY site/ ./site/
COPY --from=press /work/press/dist/ ./press/dist/
RUN node --disable-warning=ExperimentalWarning site/build.ts --commit "$SITE_COMMIT"

# 3. Serve the result.
FROM nginx:1.27-alpine
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/site/dist/ /usr/share/nginx/html/
EXPOSE 80
