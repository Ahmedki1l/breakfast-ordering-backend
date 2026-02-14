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
