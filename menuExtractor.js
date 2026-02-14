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

  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    {
      inlineData: {
        data: base64Image,
        mimeType
      }
    }
  ]);

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
  const imagePromises = imageUrls.map(async (url) => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      return { data: base64, mimeType: contentType.split(';')[0] };
    } catch {
      return null;
    }
  });

  const images = (await Promise.all(imagePromises)).filter(Boolean);

  if (images.length === 0) {
    throw new Error('Could not download any images');
  }

  // Build prompt with all images
  const parts = [
    `You are a menu extraction expert. These are photos from a restaurant's Google Maps profile.
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
- Return ONLY valid JSON`,
    ...images.map(img => ({
      inlineData: img
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
