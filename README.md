# donkey-web

Browser-first donkeycar: drive, train, autopilot.

## Test

Run the browser test suite with:

```bash
CHROME_PATH=/usr/bin/google-chrome bash ./scripts/test.sh
```

Notes:
- `scripts/test.sh` runs only `test/*.test.js`, one file at a time.
- `CHROME_PATH` forces Puppeteer to use the non-Snap Chrome binary on Ubuntu when available.
