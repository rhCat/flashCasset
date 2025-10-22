# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app

# If you have package-lock.json, npm ci is perfect.
COPY package*.json ./
RUN npm ci

COPY . .
# Build so the app works under https://domain/fcasset/
RUN npm run build -- --base=/fcasset/

# ---------- serve ----------
FROM nginx:1.27-alpine
# Our vhost for serving the SPA under /fcasset/
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Put built files under /usr/share/nginx/html/fcasset/
COPY --from=build /app/dist /usr/share/nginx/html/fcasset
# ensure nginx can read everything
RUN find /usr/share/nginx/html -type d -exec chmod 755 {} \; \
 && find /usr/share/nginx/html -type f -exec chmod 644 {} \;

EXPOSE 80
