# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the app (server.js, index.html, assets, etc.)
COPY . .

# Cloud Run injects the PORT env variable — default to 3000 locally
ENV PORT=3000
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
