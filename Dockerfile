FROM node:20-slim

WORKDIR /app

# Copy dependency definition
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy all project files
COPY . .

# Expose port
EXPOSE 8000

# Start server
CMD ["npm", "start"]
