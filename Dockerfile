FROM node:20-bookworm

# Set environment variables to run Chrome in headless mode smoothly
ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies: Python, Chrome dependencies, and Tesseract OCR
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    wget \
    gnupg \
    ca-certificates \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-mal \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome Stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Set up a Python Virtual Environment and install python requirements
COPY requirements.txt ./
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

# Copy Node dependencies and install them
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the application files
COPY . .

# Expose the server port
EXPOSE 8000

# Start server
CMD ["npm", "start"]
