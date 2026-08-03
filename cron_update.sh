#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Kerala Rain Holiday Watch — Cron Automation Script for Linux/Ubuntu
# ══════════════════════════════════════════════════════════════════════════════

# Get the directory where this script is located (resolves symlinks)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

cd "$DIR" || exit 1

# Define logs location
LOG_FILE="scraper.log"

# Print header with timestamp
echo "==================================================" >> "$LOG_FILE"
echo "RUN STARTED: $(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$LOG_FILE"
echo "==================================================" >> "$LOG_FILE"

# check if virtual env exists; if so, activate it
if [ -d "venv" ]; then
    echo "[*] Activating virtual environment..." >> "$LOG_FILE"
    source venv/bin/activate
elif [ -d ".venv" ]; then
    echo "[*] Activating virtual environment (.venv)..." >> "$LOG_FILE"
    source .venv/bin/activate
fi

# Run the python script and route all output to log file
python3 auto_update.py >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "[+] Scrape run completed successfully." >> "$LOG_FILE"
else
    echo "[!] Error: Scraper exited with code $EXIT_CODE." >> "$LOG_FILE"
fi

echo "RUN ENDED: $(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

exit $EXIT_CODE
