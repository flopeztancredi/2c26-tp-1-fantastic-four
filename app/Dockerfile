FROM node:24
RUN mkdir /opt/app
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENTRYPOINT [ "node", "app.js" ]
