# logzio-docker
#
# VERSION 2.0.1

FROM node:26-alpine
MAINTAINER Ran Ramati <ran@logz.io>
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.js docker-event-log.js ./
ENTRYPOINT ["node", "/usr/src/app/index.js"]
CMD []
