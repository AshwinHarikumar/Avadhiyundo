# Tesseract OCR Setup for Kerala Rain Holiday Watch

This project uses Tesseract OCR to read Malayalam and English text from image posters that District Collectors publish on Facebook. Without Tesseract installed, the scraper will skip image posts entirely and rely only on text captions.

## What You Need

- **Tesseract OCR engine** — the binary that does the actual reading
- **Malayalam language pack (`mal`)** — trained data for reading Malayalam script
- **English language pack (`eng`)** — usually included with Tesseract by default

## Installation

### Windows

1. **Download the installer:**
   - Go to https://github.com/UB-Mannheim/tesseract/wiki
   - Download the latest `.exe` installer (e.g., `tesseract-ocr-w64-setup-5.3.3.exe`)

2. **Run the installer:**
   - During installation, when prompted for "Additional language data", make sure **Malayalam** is checked
   - The installer puts Tesseract in `C:\Program Files\Tesseract-OCR\` by default

3. **Add to PATH:**
   - Open System Properties → Environment Variables
   - Edit the `Path` variable and add: `C:\Program Files\Tesseract-OCR`
   - Or set `TESSERACT_CMD` environment variable if using a non-standard path:
     ```
     TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
     ```

4. **Verify:**
   ```bash
   tesseract --version
   tesseract --list-langs
   ```
   You should see `mal` and `eng` in the language list.

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install tesseract-ocr tesseract-ocr-mal
```

Verify:
```bash
tesseract --list-langs
```

### macOS

```bash
brew install tesseract tesseract-lang
```

Verify:
```bash
tesseract --list-langs
```

## Python Dependencies

Already in `requirements.txt`:
```
pytesseract
Pillow
```

Install:
```bash
pip install pytesseract Pillow
```

## Testing

Run the scraper standalone to verify OCR is working:

```bash
python fb_scraper.py --districts Ernakulam --max-posts 2
```

Check the output:
- `ocrAvailable: true` means Tesseract is reachable
- If a district has `isImagePost: true` in the findings, OCR successfully read a poster

## Troubleshooting

**"pytesseract.TesseractNotFoundError"**
- Tesseract binary is not in PATH
- Set the `TESSERACT_CMD` environment variable to the full path

**OCR returns garbage text**
- The image quality is too low, or
- The poster contains very stylized fonts, or
- Malayalam language pack is missing — re-run installer and check "Malayalam"

**"TesseractError: (1, 'Error opening data file')"**
- Language pack files are missing
- On Windows, they should be in `C:\Program Files\Tesseract-OCR\tessdata\`
- Manually download `mal.traineddata` from https://github.com/tesseract-ocr/tessdata and place it there

## Production Deployment (Docker)

If deploying in a Docker container, add to your `Dockerfile`:

```dockerfile
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-mal \
    && rm -rf /var/lib/apt/lists/*
```

## What Happens When Tesseract Is Not Installed

The scraper will:
1. Log: `OCR unavailable — image posts will be skipped`
2. Return `ocrAvailable: false` in the JSON output
3. Skip any image posts and only parse text captions
4. Fall back to news sources for districts that posted image-only announcements

This is by design — the site still works without OCR, it just misses some Collector posts.
