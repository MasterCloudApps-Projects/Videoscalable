FROM node:14.18.1

# Create app directory
WORKDIR /usr/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

EXPOSE 3000


CMD [ "npm", "start" ]
