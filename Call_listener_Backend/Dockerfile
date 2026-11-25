FROM node:20-alpine

# 1) Basics
WORKDIR /usr/src/app

# 2) Create an unprivileged user and give it the app dir
RUN addgroup -S nodegrp && adduser -S nodeusr -G nodegrp \
 && chown -R nodeusr:nodegrp /usr/src/app

# 3) Switch to that user *before* installing deps
USER nodeusr

# 4) Copy only manifests first (faster layer caching)
COPY --chown=nodeusr:nodegrp package*.json ./

# 5) Use your lockfile
RUN npm ci --omit=dev --no-audit --no-fund

# 6) Now copy the rest
COPY --chown=nodeusr:nodegrp . .

# 7) Runtime config
ENV NODE_ENV=production
EXPOSE 3000 4000
CMD ["node", "server/index.js"]
