import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';

const EXTRACTION_PROMPT = `You are a menu extraction expert. Analyze this restaurant menu image and extract ALL menu items with their prices.

Return a JSON object with this EXACT structure:
{
  "items": [
    {
      "name": "Item Name",
      "category": "Category Name",
      "variants": [
        { "label": "default", "price": 25.00 }
      ]
    }
  ]
}

RULES:
1. If an item has multiple sizes/options (Small, Medium, Large / Regular, Family / etc.), list each as a separate variant:
   "variants": [
     { "label": "Small", "price": 20 },
     { "label": "Medium", "price": 30 },
     { "label": "Large", "price": 40 }
   ]
2. If an item has only ONE price, use: "variants": [{ "label": "default", "price": 25 }]
3. Group items by their menu category (Sandwiches, Drinks, Desserts, etc.)
4. Extract Arabic and English names as-is from the menu
5. Prices must be numbers, not strings
6. Include ALL items visible in the image
7. Return ONLY valid JSON, no markdown or extra text`;

const MENU_FROM_PHOTOS_PROMPT = `You are a menu extraction expert. These are photos from a restaurant's Google Maps profile.
Some photos may be menu images, some may be food photos, and some may be interior/exterior shots.

Your job:
1. Look at ALL the photos
2. If any photo shows a MENU (with items and prices), extract ALL items from it
3. If photos show FOOD DISHES but no menu/prices, try to identify the dish names
4. Ignore photos that are not food or menu related

Return a JSON object with this EXACT structure:
{
  "items": [
    {
      "name": "Item Name",
      "category": "Category Name",
      "variants": [
        { "label": "default", "price": 25.00 }
      ]
    }
  ],
  "source": "menu" or "photos" or "none"
}

RULES:
- If you found a menu with prices, set source to "menu"
- If you could only identify food from photos (no prices), set price to 0 and source to "photos"
- If no food/menu content found, return {"items": [], "source": "none"}
- Multiple sizes → multiple variants
- Extract Arabic and English names as-is
- Prices must be numbers
- Return ONLY valid JSON`;

export async function extractMenuFromImage(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');
  
  // Detect mime type from extension
  const ext = imagePath.toLowerCase().split('.').pop();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const mimeType = mimeMap[ext] || 'image/jpeg';

  const parts = [
    EXTRACTION_PROMPT,
    {
      inlineData: {
        data: base64Image,
        mimeType
      }
    }
  ];

  // Retry with exponential backoff for 500/429 errors
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await model.generateContent(parts);
      break;
    } catch (err) {
      const status = err.status || err.httpStatusCode;
      if ((status === 429 || status === 500 || status === 503) && attempt < 3) {
        const delay = attempt * 3000;
        console.log(`  Gemini error ${status}, retrying in ${delay / 1000}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  const response = result.response;
  const text = response.text();
  
  // Parse JSON from response (strip markdown code fences if present)
  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
  }
  
  const parsed = JSON.parse(jsonText.trim());
  
  // Validate structure
  if (!parsed.items || !Array.isArray(parsed.items)) {
    throw new Error('AI response missing items array');
  }
  
  // Sanitize and validate each item
  return parsed.items.map(item => ({
    name: String(item.name || '').trim(),
    category: String(item.category || 'Uncategorized').trim(),
    variants: (item.variants || []).map(v => ({
      label: String(v.label || 'default').trim(),
      price: Number(v.price) || 0
    })).filter(v => v.price > 0 && v.label)
  })).filter(item => item.name && item.variants.length > 0);
}

/**
 * Extract menu from Google Maps photo URLs.
 * Downloads images and sends them ALL to Gemini in one request.
 */
export async function extractMenuFromUrls(imageUrls) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  if (!imageUrls || imageUrls.length === 0) {
    throw new Error('No image URLs provided');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Download all images in parallel
  const imagePromises = imageUrls.map(async (url, idx) => {
    try {
      console.log(`  Downloading photo ${idx + 1}/${imageUrls.length}: ${url.substring(0, 80)}...`);
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/*,*/*',
          'Referer': process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}/`,
        }
      });
      if (!response.ok) {
        console.log(`  Photo ${idx + 1} failed: HTTP ${response.status}`);
        return null;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 1000) {
        console.log(`  Photo ${idx + 1} too small (${buffer.byteLength} bytes), skipping`);
        return null;
      }
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      console.log(`  Photo ${idx + 1} downloaded: ${(buffer.byteLength / 1024).toFixed(0)}KB, ${contentType}`);
      const base64 = Buffer.from(buffer).toString('base64');
      return { data: base64, mimeType: contentType.split(';')[0] };
    } catch (err) {
      console.log(`  Photo ${idx + 1} error: ${err.message}`);
      return null;
    }
  });

  const images = (await Promise.all(imagePromises)).filter(Boolean);
  console.log(`  Downloaded ${images.length}/${imageUrls.length} photos successfully`);

  if (images.length === 0) {
    throw new Error('Could not download any images. The Google Maps photo URLs may require browser authentication.');
  }

  const parts = [
    MENU_FROM_PHOTOS_PROMPT,
    ...images.map(img => ({
      inlineData: img
    }))
  ];

  // Retry with backoff for rate limits
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        const delay = (attempt * 20) * 1000; // 20s, 40s
        console.log(`  Gemini rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, delay));
      }
      const result = await model.generateContent(parts);
      const text = result.response.text();

      let jsonText = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonText = jsonMatch[1];

      const parsed = JSON.parse(jsonText.trim());

      if (!parsed.items || !Array.isArray(parsed.items)) {
        throw new Error('AI response missing items array');
      }

      return {
        items: parsed.items.map(item => ({
          name: String(item.name || '').trim(),
          category: String(item.category || 'Uncategorized').trim(),
          variants: (item.variants || []).map(v => ({
            label: String(v.label || 'default').trim(),
            price: Number(v.price) || 0
          })).filter(v => v.label)
        })).filter(item => item.name),
        source: parsed.source || 'unknown'
      };
    } catch (err) {
      lastError = err;
      if (err.status !== 429 && !err.message?.includes('429')) break;
    }
  }
  throw lastError || new Error('Failed after retries');
}

/**
 * Extract menu from pre-downloaded base64 images.
 * Images are downloaded in the browser and sent as base64 data.
 */
export async function extractMenuFromBase64(images) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  if (!images || images.length === 0) {
    throw new Error('No images provided');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const parts = [
    MENU_FROM_PHOTOS_PROMPT,
    ...images.map(img => ({
      inlineData: {
        data: img.data,
        mimeType: img.mimeType || 'image/jpeg'
      }
    }))
  ];

  const result = await model.generateContent(parts);
  const text = result.response.text();

  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonText = jsonMatch[1];

  const parsed = JSON.parse(jsonText.trim());

  if (!parsed.items || !Array.isArray(parsed.items)) {
    throw new Error('AI response missing items array');
  }

  return {
    items: parsed.items.map(item => ({
      name: String(item.name || '').trim(),
      category: String(item.category || 'Uncategorized').trim(),
      variants: (item.variants || []).map(v => ({
        label: String(v.label || 'default').trim(),
        price: Number(v.price) || 0
      })).filter(v => v.label)
    })).filter(item => item.name),
    source: parsed.source || 'unknown'
  };
}
