import { GoogleGenAI } from "@google/genai";
import * as cheerio from "cheerio";
import { promises as fs } from "fs";
import sharp from "sharp";

interface Municipality {
  name: string;
  bfsId: string;
  url: string;
  image?: string;
  flag?: string;
  stylizedImage?: string;
  geography?: string;
  appearance?: string;
  pointsOfInterest?: string[];
}

const BATCH_SIZE = 5;

const WIKIPEDIA_BASE_URL = "https://de.wikipedia.org";
const MUNICIPALITIES_LIST_URL =
  "https://de.wikipedia.org/wiki/Liste_Schweizer_Gemeinden";

// Google Cloud Configuration
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "pan-lab-x";

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

async function convertSvgToPng(
  svgUrl: string,
  outputPath: string
): Promise<string | null> {
  try {
    // Download the SVG
    const response = await fetch(svgUrl);
    if (!response.ok) {
      console.error(`  Failed to download SVG from ${svgUrl}`);
      return null;
    }

    const svgBuffer = Buffer.from(await response.arrayBuffer());

    // Convert SVG to PNG with sharp
    await sharp(svgBuffer, { density: 300 })
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath);

    console.log(`  Converted SVG to PNG: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error(`  Error converting SVG to PNG:`, error);
    return null;
  }
}

async function generateStylizedImage(
  municipality: {
    name: string;
    geography?: string;
    pointsOfInterest?: string[];
    flagPath?: string;
    imagePath?: string;
  },
  maxRetries: number = 3
): Promise<string | null> {
  // Check if image already exists
  const outputDir = "output/images";
  const baseFileName = municipality.name.replace(/[^a-zA-Z0-9]/g, "_");
  const pngPath = `${outputDir}/${baseFileName}_stylized.png`;
  const jpgPath = `${outputDir}/${baseFileName}_stylized.jpg`;

  try {
    await fs.access(pngPath);
    console.log(
      `  Stylized image already exists: ${baseFileName}_stylized.png`
    );
    return pngPath;
  } catch {
    // PNG doesn't exist, check for JPG
    try {
      await fs.access(jpgPath);
      console.log(
        `  Stylized image already exists: ${baseFileName}_stylized.jpg`
      );
      return jpgPath;
    } catch {
      // Neither exists, continue to generate
    }
  }

  // Build the prompt with municipality details
  const geographyDesc = municipality.geography || "rolling hills and forests";

  // Build landmarks description
  let landmarksDesc = "";
  if (municipality.pointsOfInterest && municipality.pointsOfInterest.length > 0) {
    const pois = municipality.pointsOfInterest;
    if (pois.length === 1) {
      landmarksDesc = `The scene prominently features ${pois[0]}.`;
    } else if (pois.length === 2) {
      landmarksDesc = `The scene prominently features ${pois[0]} and ${pois[1]}.`;
    } else {
      const lastPoi = pois[pois.length - 1];
      const otherPois = pois.slice(0, -1).join(", ");
      landmarksDesc = `The scene prominently features ${otherPois}, and ${lastPoi}.`;
    }
  } else {
    landmarksDesc = "The scene features traditional Swiss architecture and buildings.";
  }

  // Build the prompt
  let prompt = `A stylized 3D isometric diorama of the municipality ${municipality.name}, visualized as a cute miniature floating island on a square base.`;

  // Add reference to municipality photo if available
  if (municipality.imagePath) {
    prompt += ` Use the reference photograph to capture the architectural style and landscape features of the real location.`;
  }

  prompt += ` The scene features ${geographyDesc}. ${landmarksDesc} Surround this with cluster of traditional Swiss houses, green trees, and winding roads.`;

  // Add flag instruction if available
  if (municipality.flagPath) {
    prompt += ` Include the municipality's coat of arms flag (shown in the reference image) on a flagpole or displayed on one of the buildings.`;
  }

  prompt += ` The style is low-poly, smooth, vibrant, and toy-like. The name '${municipality.name}' is written in large, bold, dark-grey sans-serif text floating above the scene. Soft, bright lighting with a clean pastel background.`;

  // Use GoogleGenAI with Vertex AI (global region for image generation)
  const ai = new GoogleGenAI({
    vertexai: true,
    project: GOOGLE_CLOUD_PROJECT,
    location: "global",
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Prepare content parts
      const contentParts: any[] = [{ text: prompt }];

      // Add municipality photo if available
      if (municipality.imagePath) {
        try {
          const response = await fetch(municipality.imagePath);
          if (!response.ok) {
            console.log(`  Municipality photo fetch failed (${response.status}), skipping`);
          } else {
            const buffer = Buffer.from(await response.arrayBuffer());

            // Validate that we got actual image data
            if (buffer.length === 0) {
              console.log(`  Municipality photo is empty, skipping`);
            } else {
              // Determine mime type
              const mimeType = municipality.imagePath.toLowerCase().endsWith('.png')
                ? 'image/png'
                : municipality.imagePath.toLowerCase().endsWith('.jpg') || municipality.imagePath.toLowerCase().endsWith('.jpeg')
                ? 'image/jpeg'
                : 'image/jpeg'; // default

              // Convert to PNG if it's a potentially problematic format
              let imageData: string;
              if (municipality.imagePath.toLowerCase().includes('.svg') ||
                  mimeType === 'image/jpeg' && buffer.length < 1000) {
                // Skip potentially invalid images
                console.log(`  Municipality photo may be invalid format, skipping`);
              } else {
                imageData = buffer.toString('base64');
                contentParts.push({
                  inlineData: {
                    mimeType,
                    data: imageData,
                  },
                });
              }
            }
          }
        } catch (error) {
          console.log(`  Could not load municipality photo, continuing without it:`, error);
        }
      }

      // Add flag image if available
      if (municipality.flagPath) {
        try {
          let flagData: string;
          let mimeType = 'image/png';

          // Check if it's an SVG that needs conversion
          if (municipality.flagPath.toLowerCase().endsWith('.svg')) {
            // Convert SVG to PNG
            const response = await fetch(municipality.flagPath);
            if (!response.ok) {
              console.log(`  Flag fetch failed (${response.status}), skipping`);
            } else {
              const svgBuffer = Buffer.from(await response.arrayBuffer());

              if (svgBuffer.length === 0) {
                console.log(`  Flag SVG is empty, skipping`);
              } else {
                // Convert using sharp
                const pngBuffer = await sharp(svgBuffer, { density: 300 })
                  .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                  .png()
                  .toBuffer();

                flagData = pngBuffer.toString('base64');
                mimeType = 'image/png';

                contentParts.push({
                  inlineData: {
                    mimeType,
                    data: flagData,
                  },
                });
              }
            }
          } else {
            // Load image as-is
            let buffer: Buffer | null = null;
            if (municipality.flagPath.startsWith('http')) {
              // Download from URL
              const response = await fetch(municipality.flagPath);
              if (!response.ok) {
                console.log(`  Flag fetch failed (${response.status}), skipping`);
              } else {
                buffer = Buffer.from(await response.arrayBuffer());
              }
            } else {
              // Read local file
              buffer = await fs.readFile(municipality.flagPath);
            }

            if (!buffer || buffer.length === 0) {
              console.log(`  Flag image is empty or fetch failed, skipping`);
            } else {
              flagData = buffer.toString('base64');

              // Determine mime type for non-SVG
              mimeType = municipality.flagPath.toLowerCase().endsWith('.png')
                ? 'image/png'
                : 'image/jpeg';

              contentParts.push({
                inlineData: {
                  mimeType,
                  data: flagData,
                },
              });
            }
          }
        } catch (error) {
          console.log(`  Could not load flag image, continuing without it:`, error);
        }
      }

      const res = await ai.models.generateContent({
        model: "gemini-3-pro-image-preview",
        contents: [
          {
            role: "user",
            parts: contentParts,
          },
        ],
        config: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      });

      // Response contains parts; find the image part (inlineData)
      const responseParts = res.candidates?.[0]?.content?.parts ?? [];
      const imagePart = responseParts.find((p: any) => p.inlineData?.data);

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
  name: string
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

    // Use GoogleGenAI with Vertex AI (global region)
    const ai = new GoogleGenAI({
      vertexai: true,
      project: GOOGLE_CLOUD_PROJECT,
      location: "global",
    });

    const prompt = `Extract the following information from this Wikipedia page for a Swiss municipality:

1. From the INFOBOX, extract:
   - The BFS number (BFS-Nr., Gemeindenummer, or similar)
   - The COAT OF ARMS/FLAG image:
     * Look for images labeled "Wappen", "Coat of arms", "Blason"
     * Look for filenames containing "wappen", "blason", "coat"
     * Find the parent <a> tag of the img to get the Wikipedia File page link
     * The link usually looks like /wiki/File:... or /wiki/Datei:...
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
  "flagPageUrl": "the Wikipedia File/Datei page URL for coat of arms/flag or null",
  "imagePageUrl": "the Wikipedia File/Datei page URL or null if no actual photo found",
  "geography": "brief geography description or null",
  "appearance": "brief appearance description or null",
  "pointsOfInterest": ["landmark1", "landmark2"] or null
}

INFOBOX HTML:
${infoboxHtml}

ARTICLE CONTENT:
${articleContent}`;

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    });

    // Extract text from response
    const candidates = result.candidates;
    if (!candidates || candidates.length === 0) {
      console.log(`  No response from AI for ${name}`);
      return null;
    }

    const content = candidates[0]?.content;
    if (!content) {
      console.log(`  No content in response for ${name}`);
      return null;
    }

    const parts = content.parts;
    if (!parts || parts.length === 0) {
      console.log(`  No parts in response for ${name}`);
      return null;
    }

    const textPart = parts.find((p: any) => p.text);
    const responseText = textPart?.text || "";

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

    // Get high-resolution flag if available
    let flagUrl: string | null = null;
    if (data.flagPageUrl) {
      flagUrl = await getHighResImageUrl(data.flagPageUrl);
    }

    const municipality: Municipality = {
      name,
      bfsId: data.bfsId || "",
      url,
      ...(imageUrl && { image: imageUrl }),
      ...(flagUrl && { flag: flagUrl }),
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
      flagPath: flagUrl || undefined,
      imagePath: imageUrl || undefined,
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
  console.log(`Using location: global (for Gemini models)`);

  // Get all municipality links
  const municipalityLinks = await getMunicipalityLinks();

  // Prepare output directory
  const outputDir = "output";
  const outputPath = `${outputDir}/municipalities.json`;
  await fs.mkdir(outputDir, { recursive: true });

  // Load existing municipalities if file exists
  let municipalities: Municipality[] = [];
  try {
    const existingData = await fs.readFile(outputPath, "utf-8");
    municipalities = JSON.parse(existingData);
    console.log(`Loaded ${municipalities.length} existing municipalities`);
  } catch {
    console.log("No existing data found, starting fresh");
  }

  // Create a set of already processed municipality names
  const processedNames = new Set(municipalities.map((m) => m.name));

  // Filter out already processed municipalities
  const linksToProcess = municipalityLinks.filter(
    ({ name }) => !processedNames.has(name)
  );

  console.log(
    `${linksToProcess.length} municipalities to process (${processedNames.size} already done)`
  );

  // Process in batches to avoid rate limits

  for (let i = 0; i < linksToProcess.length; i += BATCH_SIZE) {
    const batch = linksToProcess.slice(i, i + BATCH_SIZE);

    console.log(
      `\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
        linksToProcess.length / BATCH_SIZE
      )}`
    );

    const results = await Promise.all(
      batch.map(({ name, url }) => extractMunicipalityData(url, name))
    );

    municipalities.push(
      ...results.filter((m): m is Municipality => m !== null)
    );

    // Write results after each batch
    await fs.writeFile(outputPath, JSON.stringify(municipalities, null, 2));
    console.log(`  Saved ${municipalities.length} municipalities so far...`);

    // Wait a bit between batches to avoid rate limits
    if (i + BATCH_SIZE < linksToProcess.length) {
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
