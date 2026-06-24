FROM registry.access.redhat.com/ubi10/nodejs-24-minimal
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY profiles/ ./profiles/
EXPOSE 8089
CMD ["node", "dist/index.js"]
