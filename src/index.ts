import { VertexAI } from "@google-cloud/vertexai";
import { GoogleGenAI } from "@google/genai";
import * as cheerio from "cheerio";
import { promises as fs } from "fs";

interface Municipality {
  name: string;
  bfsId: string;
  url: string;
  image?: string;
  stylizedImage?: string;
  geography?: string;
  appearance?: string;
  pointsOfInterest?: string[];
}

const WIKIPEDIA_BASE_URL = "https://de.wikipedia.org";
const MUNICIPALITIES_LIST_URL =
  "https://de.wikipedia.org/wiki/Liste_Schweizer_Gemeinden";

// Vertex AI Configuration
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "pan-lab-x";
const GOOGLE_CLOUD_LOCATION =
  process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

async function fetchHTML(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }
  return response.text();
}

async function getHighResImageUrl(filePageUrl: string): Promise<string | null> {
  try {
    const fullUrl = WIKIPEDIA_BASE_URL + filePageUrl;
    const html = await fetchHTML(fullUrl);
    const $ = cheerio.load(html);

    // Look for the original file link
    const originalFileLink = $(".fullMedia a").first().attr("href");
    if (originalFileLink) {
      // Convert relative URL to absolute
      if (originalFileLink.startsWith("//")) {
        return "https:" + originalFileLink;
      } else if (originalFileLink.startsWith("/")) {
        return WIKIPEDIA_BASE_URL + originalFileLink;
      }
      return originalFileLink;
    }

    return null;
  } catch (error) {
    console.error(
      `  Error fetching high-res image from ${filePageUrl}:`,
      error
    );
    return null;
  }
}

async function generateStylizedImage(
  municipality: {
    name: string;
    geography?: string;
    pointsOfInterest?: string[];
  },
  maxRetries: number = 3
): Promise<string | null> {
  // Build the prompt with municipality details
  const geographyDesc = municipality.geography || "rolling hills and forests";
  const landmark =
    municipality.pointsOfInterest && municipality.pointsOfInterest.length > 0
      ? municipality.pointsOfInterest[0]
      : "a historic church with a tall tower";

  const prompt = `A stylized 3D isometric diorama of the municipality ${municipality.name}, visualized as a cute miniature floating island on a square base. The scene features ${geographyDesc}. The central focal point is ${landmark}. Surround this with cluster of traditional Swiss houses, green trees, and winding roads. The style is low-poly, smooth, vibrant, and toy-like. The name '${municipality.name}' is written in large, bold, dark-grey sans-serif text floating above the scene. Soft, bright lighting with a clean pastel background.`;

  // Use GoogleGenAI with Vertex AI (global region for image generation)
  const ai = new GoogleGenAI({
    vertexai: true,
    project: GOOGLE_CLOUD_PROJECT,
    location: "global",
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: "gemini-3-pro-image-preview",
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        config: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      });

      // Response contains parts; find the image part (inlineData)
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p: any) => p.inlineData?.data);

      if (!imagePart || !imagePart.inlineData) {
        console.log(`  No image generated for ${municipality.name}`);
        return null;
      }

      const mimeType = imagePart.inlineData.mimeType ?? "image/png";
      const b64 = imagePart.inlineData.data as string;

      // Save the image to output directory
      const outputDir = "output/images";
      await fs.mkdir(outputDir, { recursive: true });

      const ext = mimeType.includes("jpeg") ? "jpg" : "png";
      const fileName = `${municipality.name.replace(
        /[^a-zA-Z0-9]/g,
        "_"
      )}_stylized.${ext}`;
      const filePath = `${outputDir}/${fileName}`;

      // Decode base64 and save
      const buffer = Buffer.from(b64, "base64");
      await fs.writeFile(filePath, buffer);

      console.log(`  Generated stylized image: ${fileName}`);
      return filePath;
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const errorMsg = error?.message || String(error);

      if (
        errorMsg.includes("500") ||
        errorMsg.includes("INTERNAL") ||
        errorMsg.includes("RESOURCE_EXHAUSTED")
      ) {
        if (isLastAttempt) {
          console.log(
            `  Could not generate stylized image for ${municipality.name} after ${maxRetries} attempts (API error)`
          );
          return null;
        }
        // Wait before retrying (exponential backoff)
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(
          `  Retrying image generation for ${municipality.name} (attempt ${
            attempt + 1
          }/${maxRetries}) after ${waitTime}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } else {
        console.log(
          `  Error generating stylized image for ${municipality.name}: ${errorMsg}`
        );
        return null;
      }
    }
  }

  return null;
}

async function getMunicipalityLinks(): Promise<
  Array<{ name: string; url: string }>
> {
  console.log("Fetching list of municipalities...");
  const html = await fetchHTML(MUNICIPALITIES_LIST_URL);
  const $ = cheerio.load(html);

  const links: Array<{ name: string; url: string }> = [];

  // Find all table rows with municipality data
  $("table.wikitable tr").each((_, row) => {
    const $row = $(row);
    const firstCell = $row.find("td").first();
    const link = firstCell.find("a").first();

    if (link.length > 0) {
      const href = link.attr("href");
      const name = link.text().trim();

      if (href && href.startsWith("/wiki/") && !href.includes(":")) {
        links.push({
          name,
          url: WIKIPEDIA_BASE_URL + href,
        });
      }
    }
  });

  console.log(`Found ${links.length} municipalities`);
  return links;
}

async function extractMunicipalityData(
  url: string,
  name: string,
  vertexAI: VertexAI
): Promise<Municipality | null> {
  try {
    console.log(`Processing: ${name}`);

    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    // Extract the infobox (sidebar) content
    const infobox = $(".infobox").first();
    if (infobox.length === 0) {
      console.log(`  No infobox found for ${name}`);
      return null;
    }

    // Get the infobox HTML
    const infoboxHtml = infobox.html() || "";

    // Extract the main article content (first few paragraphs)
    const contentParagraphs: string[] = [];
    $("#mw-content-text .mw-parser-output > p").each((i, elem) => {
      if (i < 5) {
        // Get first 5 paragraphs
        const text = $(elem).text().trim();
        if (text.length > 50) {
          // Skip very short paragraphs
          contentParagraphs.push(text);
        }
      }
    });
    const articleContent = contentParagraphs.join("\n\n");

    // Use Gemini via Vertex AI to extract structured data
    const model = vertexAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
    });

    const prompt = `Extract the following information from this Wikipedia page for a Swiss municipality:

1. From the INFOBOX, extract:
   - The BFS number (BFS-Nr., Gemeindenummer, or similar)
   - The best PHOTO/IMAGE (NOT coat of arms):
     * CRITICAL: Look for images labeled "Ansicht", "Luftbild", "Panorama", or similar - these are photos
     * CRITICAL: SKIP images labeled "Wappen", "Coat of arms", "Blason" - these are NOT photos
     * CRITICAL: SKIP images with filenames containing "wappen", "blason", "coat" - these are NOT photos
     * PREFER: Actual photographs showing landscapes, buildings, town views, streets, architecture
     * AVOID: Coats of arms (Wappen), flags, maps, location diagrams, symbolic images
     * Find the parent <a> tag of the img to get the Wikipedia File page link (not the thumbnail src)
     * The link usually looks like /wiki/File:... or /wiki/Datei:...
     * Return NULL if only coat of arms/Wappen images are available

2. From the ARTICLE CONTENT, extract:
   - Geography: Brief description of the municipality's location and geographical features (mountains, rivers, valleys, altitude, etc.) - max 100 words
   - Appearance: Brief description of how the town looks (architecture, urban/rural character, notable buildings, atmosphere) - max 100 words
   - Points of Interest: Array of notable landmarks, attractions, or places (churches, castles, museums, natural sites, etc.) - list of strings

Return the data in JSON format:
{
  "bfsId": "the BFS number as a string",
  "imagePageUrl": "the Wikipedia File/Datei page URL or null if no actual photo found",
  "geography": "brief geography description or null",
  "appearance": "brief appearance description or null",
  "pointsOfInterest": ["landmark1", "landmark2"] or null
}

INFOBOX HTML:
${infoboxHtml}

ARTICLE CONTENT:
${articleContent}`;

    const result = await model.generateContent(prompt);

    // Extract text from Vertex AI response
    const response = result.response;
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) {
      console.log(`  No response from AI for ${name}`);
      return null;
    }

    const content = candidates[0].content;
    const parts = content.parts;
    if (!parts || parts.length === 0) {
      console.log(`  No content in response for ${name}`);
      return null;
    }

    const responseText = parts[0].text || "";

    // Extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`  Could not parse JSON response for ${name}`);
      return null;
    }

    const data = JSON.parse(jsonMatch[0]);

    // Get high-resolution image if available
    let imageUrl: string | null = null;
    if (data.imagePageUrl) {
      imageUrl = await getHighResImageUrl(data.imagePageUrl);
    }

    const municipality: Municipality = {
      name,
      bfsId: data.bfsId || "",
      url,
      ...(imageUrl && { image: imageUrl }),
      ...(data.geography && { geography: data.geography }),
      ...(data.appearance && { appearance: data.appearance }),
      ...(data.pointsOfInterest &&
        data.pointsOfInterest.length > 0 && {
          pointsOfInterest: data.pointsOfInterest,
        }),
    };

    // Generate stylized image
    const stylizedImagePath = await generateStylizedImage({
      name,
      geography: data.geography,
      pointsOfInterest: data.pointsOfInterest,
    });

    if (stylizedImagePath) {
      municipality.stylizedImage = stylizedImagePath;
    }

    console.log(
      `  ✓ Extracted: BFS ${municipality.bfsId}${
        municipality.image ? " with image" : ""
      }${municipality.stylizedImage ? " + stylized" : ""}${
        municipality.pointsOfInterest
          ? ` (${municipality.pointsOfInterest.length} POIs)`
          : ""
      }`
    );
    return municipality;
  } catch (error) {
    console.error(`  Error processing ${name}:`, error);
    return null;
  }
}

async function crawlMunicipalities() {
  console.log(`Using Google Cloud project: ${GOOGLE_CLOUD_PROJECT}`);
  console.log(`Using location: ${GOOGLE_CLOUD_LOCATION}`);

  // Initialize Vertex AI (uses Application Default Credentials)
  const vertexAI = new VertexAI({
    project: GOOGLE_CLOUD_PROJECT,
    location: GOOGLE_CLOUD_LOCATION,
  });

  // Get all municipality links
  const municipalityLinks = await getMunicipalityLinks();

  // Prepare output directory
  const outputDir = "output";
  const outputPath = `${outputDir}/municipalities.json`;
  await fs.mkdir(outputDir, { recursive: true });

  // Process municipalities
  const municipalities: Municipality[] = [];

  // Process in batches to avoid rate limits
  const batchSize = 1;
  for (let i = 0; i < municipalityLinks.length; i += batchSize) {
    const batch = municipalityLinks.slice(i, i + batchSize);

    console.log(
      `\nProcessing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        municipalityLinks.length / batchSize
      )}`
    );

    const results = await Promise.all(
      batch.map(({ name, url }) => extractMunicipalityData(url, name, vertexAI))
    );

    municipalities.push(
      ...results.filter((m): m is Municipality => m !== null)
    );

    // Write results after each batch
    await fs.writeFile(outputPath, JSON.stringify(municipalities, null, 2));
    console.log(`  Saved ${municipalities.length} municipalities so far...`);

    // Wait a bit between batches to avoid rate limits
    if (i + batchSize < municipalityLinks.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n✓ Crawling complete!`);
  console.log(`  Total municipalities: ${municipalities.length}`);
  console.log(`  With images: ${municipalities.filter((m) => m.image).length}`);
  console.log(`  Output saved to: ${outputPath}`);
}

// Run the crawler
crawlMunicipalities().catch(console.error);
