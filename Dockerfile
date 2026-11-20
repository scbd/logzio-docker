# logzio-docker
#
# VERSION 2.0.1

FROM node:26-alpine
LABEL maintainer="Ran Ramati <ran@logz.io>"
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm
COPY index.js docker-event-log.js ./
ENTRYPOINT ["node", "/usr/src/app/index.js"]
CMD []
