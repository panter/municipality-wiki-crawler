# Swiss Municipality Crawler

A TypeScript crawler that extracts information about Swiss municipalities from Wikipedia using Google's Gemini AI via Vertex AI.

## Features

- Crawls all Swiss municipalities from the Wikipedia list
- Extracts:
  - Municipality name
  - BFS number (official municipality identifier)
  - Image from the Wikipedia infobox (if available)
- Uses Gemini AI via Vertex AI for intelligent data extraction
- Uses Google Cloud Application Default Credentials (no API key needed)
- Outputs results to JSON

## Setup

1. Install dependencies:
```bash
npm install
```

2. Authenticate with Google Cloud:
```bash
gcloud auth application-default login
```

3. Create a `.env` file with your Google Cloud project settings:
```bash
cp .env.example .env
```

Then edit `.env` and set your project:
```
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
```

Make sure you have:
- Vertex AI API enabled in your Google Cloud project
- Appropriate permissions to use Vertex AI

## Usage

Run the crawler in development mode:
```bash
npm run dev
```

Or build and run:
```bash
npm run build
npm start
```

The crawler will:
1. Fetch the list of all Swiss municipalities from Wikipedia
2. Visit each municipality's Wikipedia page
3. Use Gemini to extract the BFS number and image from the infobox
4. Save all results to `municipalities.json`

## Output

The output file `municipalities.json` contains an array of municipality objects:

```json
[
  {
    "name": "Zürich",
    "bfsId": "0261",
    "image": "https://upload.wikimedia.org/..."
  },
  ...
]
```

## Notes

- The crawler processes municipalities in batches of 5 to avoid rate limits
- It includes a 1-second delay between batches
- Invalid or failed extractions are skipped and logged
